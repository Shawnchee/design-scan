#!/usr/bin/env node
// design-scan: crawl a website and extract its layout, typography, colors, and
// animations into screenshots + JSON detailed enough to replicate the design.
//
// CLI: node scripts/scan.mjs <url> [--out <dir>] [--max-pages <n>] [--scroll-frames <n>]

import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Timing / limits (all ms). Kept conservative so a page never hangs.
// ---------------------------------------------------------------------------
const GOTO_TIMEOUT = 20000;        // hard cap on initial navigation per page
const NETWORKIDLE_TIMEOUT = 5000;  // bounded settle wait after DOM ready
const BREAKPOINT_SETTLE = 700;     // relayout wait after viewport resize
const POST_SCROLL_SETTLE = 500;    // wait after the auto-scroll dance
const SCROLL_FRAME_SETTLE = 300;   // wait per scroll frame
const HARD_RUNTIME_CAP = 240000;   // ~4 min total budget

const BREAKPOINTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

const START = Date.now();
const elapsed = () => ((Date.now() - START) / 1000).toFixed(1);

// ---------------------------------------------------------------------------
// Tiny CLI helpers
// ---------------------------------------------------------------------------
function fail(msg) {
  process.stderr.write(`\n✖ ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

// Bound a promise — context.setDefaultTimeout does NOT apply to page.evaluate.
function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), gate]);
}

function parseArgs(argv) {
  const args = { url: null, out: null, maxPages: 6, scrollFrames: 8 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--max-pages') args.maxPages = parseInt(argv[++i], 10);
    else if (a === '--scroll-frames') args.scrollFrames = parseInt(argv[++i], 10);
    else if (a.startsWith('--')) fail(`Unknown flag: ${a}`);
    else rest.push(a);
  }
  args.url = rest[0] || null;
  if (!Number.isFinite(args.maxPages) || args.maxPages < 1) args.maxPages = 6;
  if (!Number.isFinite(args.scrollFrames) || args.scrollFrames < 0) args.scrollFrames = 8;
  return args;
}

function normalizeInputUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL / slug / template utilities
// ---------------------------------------------------------------------------
function normalizeHref(href, origin) {
  try {
    const u = new URL(href, origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.search = '';
    let p = u.pathname.replace(/\/+$/, '');
    if (p === '') p = '/';
    u.pathname = p;
    return u;
  } catch {
    return null;
  }
}

function slugFor(pathname) {
  if (pathname === '/' || pathname === '') return 'home';
  return (
    pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\//g, '-')
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'home'
  );
}

function isDynamicSegment(seg) {
  if (!seg) return false;
  if (/^\d+$/.test(seg)) return true; // numeric
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true; // uuid
  if (seg.length >= 25) return true; // long slug
  return false;
}

// Template key: same segment count + same (static) first segment => one template.
function templateKey(pathname) {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return 'home';
  const first = isDynamicSegment(segs[0]) ? '*' : segs[0].toLowerCase();
  return `${segs.length}|${first}`;
}

// ---------------------------------------------------------------------------
// CSS text parsing (for cross-origin CSS captured via network responses)
// ---------------------------------------------------------------------------
function extractKeyframesFromCss(cssText) {
  const results = [];
  const re = /@(?:-webkit-|-moz-|-o-|-ms-)?keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const name = m[1];
    // Balance braces starting at the opening brace of this block.
    let depth = 1;
    let i = re.lastIndex;
    const start = m.index;
    while (i < cssText.length && depth > 0) {
      const ch = cssText[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) {
      results.push({ name, cssText: cssText.slice(start, i).replace(/\s+/g, ' ').trim() });
    }
    re.lastIndex = i;
  }
  return results;
}

function extractCustomPropsFromCss(cssText) {
  const props = {};
  // Only capture declarations inside :root / html / :host blocks to avoid noise.
  // Quantifiers are bounded: unbounded [^{]* backtracks quadratically on long
  // brace-free bodies (a .css URL that actually serves JS or an error page).
  const blockRe = /(:root|html|:host)[^{]{0,300}\{([^}]{0,60000})\}/g;
  let bm;
  while ((bm = blockRe.exec(cssText)) !== null) {
    const body = bm[2];
    // trailing ; is optional — minified CSS omits it on the last declaration
    const declRe = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g;
    let dm;
    while ((dm = declRe.exec(body)) !== null) {
      const name = dm[1];
      if (!(name in props)) props[name] = dm[2].trim().slice(0, 200);
    }
  }
  return props;
}

function extractFontFacesFromCss(cssText) {
  const fams = new Set();
  const re = /@font-face\s*\{([^}]{0,5000})\}/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const fm = /font-family\s*:\s*([^;]+);/i.exec(m[1]);
    if (fm) fams.add(fm[1].replace(/['"]/g, '').trim());
  }
  return [...fams];
}

// Extract :hover rules from raw CSS text (covers cross-origin/CDN stylesheets
// that document.styleSheets can't read). Linear indexOf scan — a regex with a
// leading [^{}]* backtracks quadratically on non-CSS bodies.
function extractHoverFromCss(cssText) {
  const out = [];
  let idx = 0;
  while (out.length < 200) {
    idx = cssText.indexOf(':hover', idx);
    if (idx === -1) break;
    // selector start: walk back to the previous brace (bounded)
    let s = idx;
    while (s > 0 && cssText[s - 1] !== '{' && cssText[s - 1] !== '}' && idx - s < 300) s--;
    // declaration block: next '{' … '}'
    const b = cssText.indexOf('{', idx);
    if (b === -1) break;
    if (b - idx > 300) {
      idx += 6;
      continue;
    }
    const e = cssText.indexOf('}', b);
    if (e === -1) break;
    const selector = cssText.slice(s, b).replace(/\s+/g, ' ').trim();
    const declarations = cssText.slice(b + 1, e).replace(/\s+/g, ' ').trim().slice(0, 300);
    idx = b + 1; // also skips other :hover tokens within the same selector list
    if (!selector || selector.length > 200 || !declarations) continue;
    out.push({ selector: selector.slice(0, 160), declarations });
  }
  return out;
}

// Parse each captured stylesheet body once — results are reused across pages
// (cssStore is cumulative, so per-page re-parsing was O(pages × bytes)).
const parsedCssCache = new Map();
function parseCssBody(url, cssText) {
  let parsed = parsedCssCache.get(url);
  if (parsed) return parsed;
  parsed = { keyframes: [], props: {}, fontFaces: [], hovers: [], scrollTimeline: false };
  // A body with no '{' in the first few KB is not CSS — skip it entirely.
  if (cssText.slice(0, 4096).includes('{')) {
    parsed.keyframes = extractKeyframesFromCss(cssText);
    parsed.props = extractCustomPropsFromCss(cssText);
    parsed.fontFaces = extractFontFacesFromCss(cssText);
    parsed.hovers = extractHoverFromCss(cssText);
    parsed.scrollTimeline = /animation-timeline|view-timeline|@scroll-timeline/.test(cssText);
  }
  parsedCssCache.set(url, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// In-page extraction. This function is serialized and runs in the browser.
// Everything is wrapped in try/catch so a single failure never kills the scan.
// ---------------------------------------------------------------------------
function pageExtract() {
  // Self-imposed time budget: on 100k+-node DOMs the style walks can force
  // minutes of layout — once spent, remaining sections return their fallbacks.
  const deadline = Date.now() + 15000;
  const safe = (fn, fallback) => {
    if (Date.now() > deadline) return fallback;
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  };

  const isVisible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.01;
    } catch {
      return false;
    }
  };

  const parseColor = (str) => {
    if (!str) return null;
    str = str.trim();
    if (str === 'transparent' || str === 'inherit' || str === 'initial' || str === 'currentcolor') return null;
    if (str.startsWith('#')) return str.toLowerCase();
    const m = str.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const r = Math.round(parseFloat(parts[0]));
    const g = Math.round(parseFloat(parts[1]));
    const b = Math.round(parseFloat(parts[2]));
    let a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    if (a === 0) return null; // fully transparent contributes nothing
    if (a < 1) return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})`;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return hex.toLowerCase();
  };

  const elDesc = (el) => {
    if (!el || !el.tagName) return '(none)';
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    const cls = (el.getAttribute && el.getAttribute('class')) || '';
    if (cls) d += '.' + cls.trim().split(/\s+/).slice(0, 3).join('.');
    return d.slice(0, 120);
  };

  const out = {};

  // -- designTokens: CSS custom props on :root/html/:host from accessible sheets
  out.designTokens = safe(() => {
    const tokens = {};
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin
      }
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== 1 || !rule.selectorText) continue;
        if (!/(:root|^html\b|:host)/.test(rule.selectorText)) continue;
        const style = rule.style;
        for (let i = 0; i < style.length; i++) {
          const prop = style[i];
          if (prop.startsWith('--')) tokens[prop] = style.getPropertyValue(prop).trim().slice(0, 200);
        }
      }
    }
    return tokens;
  }, {});

  // -- keyframes from accessible sheets
  out.keyframes = safe(() => {
    const kf = [];
    const seen = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type === 7 /* CSSKeyframesRule */ && rule.name && !seen.has(rule.name)) {
          seen.add(rule.name);
          kf.push({ name: rule.name, cssText: rule.cssText.replace(/\s+/g, ' ').slice(0, 2000) });
        }
      }
    }
    return kf;
  }, []);

  // -- WAAPI animations (running / declared)
  out.waapiAnimations = safe(() => {
    const anims = document.getAnimations ? document.getAnimations({ subtree: true }) : [];
    // dedupe by (name, target, duration) BEFORE capping — one repeated element
    // pattern can spawn dozens of identical Animation objects
    const byKey = new Map();
    for (const a of anims.slice(0, 300)) {
      const target = safe(() => elDesc(a.effect && a.effect.target), '(unknown)');
      const animationName = safe(() => a.animationName || null, null);
      const timing = safe(() => {
        const t = a.effect.getTiming();
        return {
          duration: t.duration,
          delay: t.delay,
          easing: t.easing,
          iterations: t.iterations,
          fill: t.fill,
          direction: t.direction,
        };
      }, null);
      const key = `${animationName || ''}|${target}|${timing ? timing.duration : ''}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        continue;
      }
      if (byKey.size >= 40) continue; // keep counting dupes, stop adding new
      const entry = { target, animationName, timing, count: 1 };
      entry.keyframes = safe(() => {
        const kfs = a.effect.getKeyframes();
        return kfs.slice(0, 12).map((k) => {
          const clean = {};
          for (const key2 of Object.keys(k)) {
            const v = k[key2];
            if (typeof v === 'string' || typeof v === 'number') clean[key2] = v;
          }
          return clean;
        });
      }, null);
      entry.playState = safe(() => a.playState, null);
      byKey.set(key, entry);
    }
    return [...byKey.values()];
  }, []);

  // -- transitions on interactive / sample elements
  out.transitions = safe(() => {
    const sel = 'a, button, [role="button"], input, textarea, select, [class*="card" i], [class*="btn" i]';
    // slice BEFORE isVisible — it touches computed style / layout per node
    const els = [...document.querySelectorAll(sel)].slice(0, 600).filter(isVisible).slice(0, 200);
    const seen = new Set();
    const list = [];
    for (const el of els) {
      const s = getComputedStyle(el);
      const dur = s.transitionDuration;
      if (!dur || dur === '0s' || /^0s(,\s*0s)*$/.test(dur)) continue;
      const sig = `${el.tagName.toLowerCase()}|${s.transitionProperty}|${dur}|${s.transitionTimingFunction}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      list.push({
        selector: elDesc(el),
        property: s.transitionProperty,
        duration: dur,
        timingFunction: s.transitionTimingFunction,
        delay: s.transitionDelay,
      });
      if (list.length >= 30) break;
    }
    return list;
  }, []);

  // -- animation / css libraries
  out.animationLibraries = safe(() => {
    const w = window;
    const libs = {};
    libs.gsap = !!w.gsap;
    libs.gsapVersion = safe(() => (w.gsap && w.gsap.version) || null, null);
    libs.scrollTrigger = !!(w.ScrollTrigger || (w.gsap && w.gsap.core && w.gsap.core.globals && w.gsap.core.globals().ScrollTrigger));
    libs.framerMotion = !!(document.querySelector('[data-framer-name], [data-framer-component-type], [data-projection-id]') || w.__framer_importFromPackage || w.FramerMotion);
    libs.lottie = !!(w.lottie || w.bodymovin || document.querySelector('lottie-player, dotlottie-player, [data-animation-path]'));
    libs.aos = !!(w.AOS || document.querySelector('[data-aos]'));
    libs.animeJs = !!(w.anime);
    libs.swiper = !!(w.Swiper || document.querySelector('.swiper, [class*="swiper" i]'));
    libs.lenis = !!(w.Lenis || w.lenis || document.querySelector('[data-lenis], .lenis, html.lenis'));
    libs.locomotiveScroll = !!(w.LocomotiveScroll || document.querySelector('[data-scroll-container], [data-scroll]'));
    libs.barba = !!w.barba;
    libs.rive = !!(w.rive || document.querySelector('canvas[data-rive], rive-animation'));
    // CSS framework heuristics
    const sampleClasses = new Set();
    for (const el of [...document.querySelectorAll('[class]')].slice(0, 400)) {
      String(el.className || '').split(/\s+/).forEach((c) => c && sampleClasses.add(c));
    }
    const cls = [...sampleClasses];
    const twHits = cls.filter((c) => /^(flex|grid|hidden|block|inline-block|text-(xs|sm|base|lg|xl|\dxl)|(p|m|px|py|mx|my|mt|mb|ml|mr|pt|pb|pl|pr)-\d|gap-\d|w-\d|h-\d|rounded(-\w+)?|bg-\w+-\d|font-(bold|semibold|medium)|items-center|justify-(center|between))$/.test(c)).length;
    libs.tailwind = twHits >= 6;
    libs.bootstrap = !!(w.bootstrap || cls.some((c) => /^(col-(sm|md|lg|xl)-\d|container-fluid|navbar-expand|btn-(primary|secondary))$/.test(c)));
    // library CDN names in script srcs
    const scriptLibs = [];
    for (const s of document.querySelectorAll('script[src]')) {
      const src = s.getAttribute('src') || '';
      [
        ['gsap', /gsap/i],
        ['scrolltrigger', /scrolltrigger/i],
        ['lottie', /lottie|bodymovin/i],
        ['aos', /\baos\b/i],
        ['anime', /anime(\.min)?\.js/i],
        ['swiper', /swiper/i],
        ['lenis', /lenis/i],
        ['locomotive', /locomotive/i],
        ['three', /three(\.min)?\.js|three\.module/i],
        ['framer-motion', /framer-motion|framer\.com/i],
        ['barba', /barba/i],
        ['rellax', /rellax/i],
      ].forEach(([name, rx]) => {
        if (rx.test(src) && !scriptLibs.includes(name)) scriptLibs.push(name);
      });
    }
    libs.scriptSrcMatches = scriptLibs;
    return libs;
  }, {});

  // -- typography
  out.typography = safe(() => {
    const tags = ['h1', 'h2', 'h3', 'h4', 'p', 'a', 'button', 'blockquote', 'li'];
    const elements = {};
    for (const tag of tags) {
      const el = [...document.querySelectorAll(tag)].find(isVisible);
      if (!el) continue;
      const s = getComputedStyle(el);
      elements[tag] = {
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
        color: parseColor(s.color) || s.color,
        textTransform: s.textTransform,
      };
    }
    const fonts = [];
    const seen = new Set();
    safe(() => {
      document.fonts.forEach((f) => {
        const key = `${f.family}|${f.weight}|${f.style}`;
        if (!seen.has(key)) {
          seen.add(key);
          fonts.push({ family: f.family, weight: f.weight, style: f.style, status: f.status });
        }
      });
    });
    const fontLinks = [...document.querySelectorAll('link[href]')]
      .map((l) => l.href)
      .filter((h) => /fonts\.googleapis|fonts\.gstatic|use\.typekit|fonts\.bunny|font/i.test(h))
      .slice(0, 15);
    return { elements, fonts: fonts.slice(0, 40), fontLinks };
  }, {});

  // -- color palette
  out.colorPalette = safe(() => {
    const counts = new Map(); // color -> {count, text, bg, border, ctaBg}
    const bump = (color, role) => {
      const c = parseColor(color);
      if (!c) return;
      if (!counts.has(c)) counts.set(c, { count: 0, text: 0, bg: 0, border: 0, ctaBg: 0 });
      const rec = counts.get(c);
      rec.count++;
      rec[role]++;
      return rec;
    };
    // "btn" misses e.g. Stripe's a.CtaButton — match "button"/"cta" classes too
    const btnSel = 'button, [role="button"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i], input[type="submit"], input[type="button"]';
    // slice BEFORE isVisible — it touches computed style / layout per node
    const els = [...document.querySelectorAll('*')].slice(0, 3000).filter(isVisible).slice(0, 1500);
    for (const el of els) {
      const s = getComputedStyle(el);
      bump(s.color, 'text');
      const bgRec = bump(s.backgroundColor, 'bg');
      // track backgrounds used on button-like elements → accent/CTA colors
      if (bgRec && el.matches && el.matches(btnSel)) bgRec.ctaBg++;
      const bw = parseFloat(s.borderTopWidth) || parseFloat(s.borderWidth) || 0;
      if (bw > 0) bump(s.borderTopColor || s.borderColor, 'border');
    }
    return [...counts.entries()]
      .map(([color, r]) => {
        let role = 'text';
        // most of this color's background usage is on buttons → it's the CTA color
        if (r.ctaBg > 0 && r.ctaBg * 2 >= r.bg) role = 'accent/cta';
        else if (r.bg >= r.text && r.bg >= r.border) role = 'bg';
        else if (r.border >= r.text && r.border >= r.bg) role = 'border';
        return { color, count: r.count, role, roles: { text: r.text, bg: r.bg, border: r.border, ctaBg: r.ctaBg } };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }, []);

  // -- layout
  out.layout = safe(() => {
    const header = document.querySelector('header, [role="banner"], [class*="header" i], [class*="navbar" i]');
    let headerInfo = null;
    if (header) {
      const s = getComputedStyle(header);
      headerInfo = {
        height: Math.round(header.getBoundingClientRect().height),
        position: s.position,
        sticky: s.position === 'sticky' || s.position === 'fixed',
        background: parseColor(s.backgroundColor) || s.backgroundColor,
      };
    }
    const navLinks = [...document.querySelectorAll('header a, nav a')]
      .map((a) => (a.textContent || '').trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 10);
    const footerGroups = document.querySelectorAll('footer ul, footer nav, footer [class*="col" i]').length;

    // container max-widths
    const mwCounts = new Map();
    for (const el of [...document.querySelectorAll('div, section, main, header, footer')].slice(0, 800)) {
      const s = getComputedStyle(el);
      const mw = s.maxWidth;
      if (mw && mw !== 'none' && /px/.test(mw)) {
        const v = Math.round(parseFloat(mw));
        if (v >= 480) mwCounts.set(v, (mwCounts.get(v) || 0) + 1);
      }
    }
    const maxWidths = [...mwCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, c]) => ({ value: v + 'px', count: c }));

    let gridCount = 0;
    let flexCount = 0;
    const radiusCounts = new Map();
    const shadowCounts = new Map();
    for (const el of [...document.querySelectorAll('*')].slice(0, 1500)) {
      const s = getComputedStyle(el);
      if (s.display === 'grid' || s.display === 'inline-grid') gridCount++;
      else if (s.display === 'flex' || s.display === 'inline-flex') flexCount++;
      const br = s.borderRadius;
      if (br && br !== '0px' && br !== '0%') radiusCounts.set(br, (radiusCounts.get(br) || 0) + 1);
      const sh = s.boxShadow;
      if (sh && sh !== 'none') shadowCounts.set(sh.slice(0, 120), (shadowCounts.get(sh.slice(0, 120)) || 0) + 1);
    }
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    return {
      header: headerInfo,
      navLinks,
      footerGroupCount: footerGroups,
      containerMaxWidths: maxWidths,
      gridSections: gridCount,
      flexSections: flexCount,
      sectionCount: document.querySelectorAll('section').length,
      bodyBackground: parseColor(bodyStyle.backgroundColor) || bodyStyle.backgroundColor,
      baseFontSize: htmlStyle.fontSize,
      scrollBehavior: htmlStyle.scrollBehavior,
      borderRadiusHistogram: [...radiusCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, c]) => ({ value: v, count: c })),
      boxShadowHistogram: [...shadowCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, c]) => ({ value: v, count: c })),
    };
  }, {});

  // -- components inventory
  out.components = safe(() => {
    const styleSig = (el) => {
      const s = getComputedStyle(el);
      return {
        background: parseColor(s.backgroundColor) || s.backgroundColor,
        color: parseColor(s.color) || s.color,
        borderRadius: s.borderRadius,
        padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
        fontWeight: s.fontWeight,
        border: s.borderTopWidth !== '0px' ? `${s.borderTopWidth} ${s.borderStyle} ${parseColor(s.borderTopColor) || s.borderTopColor}` : 'none',
      };
    };
    // "btn" misses e.g. Stripe's a.CtaButton — match "button"/"cta" classes too
    const buttons = [...document.querySelectorAll('button, [role="button"], a[class*="btn" i], a[class*="button" i], a[class*="cta" i], input[type="submit"], input[type="button"]')].slice(0, 400).filter(isVisible);
    const btnSigCounts = new Map();
    for (const b of buttons.slice(0, 120)) {
      const sig = JSON.stringify(styleSig(b));
      btnSigCounts.set(sig, (btnSigCounts.get(sig) || 0) + 1);
    }
    const rgbOf = (str) => {
      if (!str) return null;
      if (str[0] === '#' && str.length === 7) {
        return { r: parseInt(str.slice(1, 3), 16), g: parseInt(str.slice(3, 5), 16), b: parseInt(str.slice(5, 7), 16), a: 1 };
      }
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).map(parseFloat);
      if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? p[3] : 1 };
    };
    const isCtaBg = (bg) => {
      const c = rgbOf(bg);
      return !!c && c.a >= 0.5 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) >= 30;
    };
    const sigs = [...btnSigCounts.entries()]
      .map(([sig, count]) => ({ ...JSON.parse(sig), count }))
      .sort((a, b) => b.count - a.count);
    for (const s of sigs) if (isCtaBg(s.background)) s.primaryCandidate = true;
    // the most NUMEROUS signatures are usually transparent text-links; always
    // surface saturated solid-background ones too — those are the primary CTAs
    const picked = sigs.length ? [sigs[0]] : [];
    for (const s of sigs) {
      if (picked.filter((x) => x.primaryCandidate).length >= 2) break;
      if (s.primaryCandidate && !picked.includes(s)) picked.push(s);
    }
    for (const s of sigs) {
      if (picked.length >= 3) break;
      if (!picked.includes(s)) picked.push(s);
    }
    const topBtnSigs = picked.slice(0, 4);

    const cards = [...document.querySelectorAll('*')].slice(0, 3000).filter((el) => {
      if (!isVisible(el)) return false;
      const s = getComputedStyle(el);
      const hasRadius = parseFloat(s.borderRadius) >= 4;
      const hasShadow = s.boxShadow && s.boxShadow !== 'none';
      const hasBorder = parseFloat(s.borderTopWidth) > 0;
      const r = el.getBoundingClientRect();
      return hasRadius && (hasShadow || hasBorder) && r.width > 120 && r.height > 80 && el.children.length > 0;
    });

    return {
      buttons: { count: buttons.length, signatures: topBtnSigs },
      inputs: document.querySelectorAll('input, textarea, select').length,
      cards: cards.length,
      badges: document.querySelectorAll('[class*="badge" i], [class*="pill" i], [class*="tag" i], [class*="chip" i]').length,
      tables: document.querySelectorAll('table').length,
      accordions: document.querySelectorAll('details, [class*="accordion" i], [aria-expanded]').length,
      modals: document.querySelectorAll('dialog, [role="dialog"], [class*="modal" i]').length,
      carousels: document.querySelectorAll('[class*="carousel" i], [class*="swiper" i], [class*="slick" i], [class*="slider" i]').length,
      videoEmbeds: document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"]').length,
      iframes: document.querySelectorAll('iframe').length,
    };
  }, {});

  // -- meta
  out.meta = safe(() => {
    const get = (sel, attr) => {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(attr) : null;
    };
    return {
      title: document.title || null,
      description: get('meta[name="description"]', 'content'),
      themeColor: get('meta[name="theme-color"]', 'content'),
      ogImage: get('meta[property="og:image"]', 'content'),
      favicon: safe(() => {
        const l = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]');
        return l ? l.href : null;
      }, null),
      viewport: get('meta[name="viewport"]', 'content'),
      lang: document.documentElement.getAttribute('lang'),
    };
  }, {});

  // -- hover styles from accessible sheets
  out.hoverStyles = safe(() => {
    const list = [];
    const seen = new Set();
    const priority = (sel) => /button|btn|\ba\b|link|card|nav/i.test(sel) ? 0 : 1;
    const collected = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== 1 || !rule.selectorText) continue;
        if (!rule.selectorText.includes(':hover')) continue;
        if (seen.has(rule.selectorText)) continue;
        seen.add(rule.selectorText);
        const decls = rule.style.cssText.slice(0, 300);
        collected.push({ selector: rule.selectorText.slice(0, 160), declarations: decls });
      }
    }
    collected.sort((a, b) => priority(a.selector) - priority(b.selector));
    return collected.slice(0, 30);
  }, []);

  // -- scroll-motion evidence: CSS scroll/view timelines + AOS attributes
  out.scrollEvidence = safe(() => {
    let scrollTimeline = false;
    let scanned = 0;
    outer: for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      if (!rules) continue;
      for (const rule of rules) {
        if (++scanned > 8000) break outer;
        const t = rule.cssText || '';
        if (t.includes('animation-timeline') || t.includes('view-timeline') || t.includes('scroll-timeline')) {
          scrollTimeline = true;
          break outer;
        }
      }
    }
    return { scrollTimeline, aosAttrs: !!document.querySelector('[data-aos]') };
  }, { scrollTimeline: false, aosAttrs: false });

  return out;
}

// ---------------------------------------------------------------------------
// Auto-scroll dance to trigger lazy-load + scroll animations, then reset.
// ---------------------------------------------------------------------------
async function autoScrollDance(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const step = Math.max(200, Math.floor(window.innerHeight * 0.85));
      let ticks = 0;
      const maxTicks = 60;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        ticks++;
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
        if (atBottom || ticks >= maxTicks) {
          clearInterval(timer);
          resolve();
        }
      }, 110);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 8000);
    });
    window.scrollTo(0, 0);
  });
}

// ---------------------------------------------------------------------------
// Scan a single page: navigate, capture screenshots + scroll frames, extract.
// ---------------------------------------------------------------------------
async function scanPage(context, pageUrl, slug, outDir, scrollFrames, cssStore, deadline) {
  const page = await context.newPage();
  const pageDir = path.join(outDir, 'pages', slug);
  await mkdir(pageDir, { recursive: true });

  // Capture CSS bodies (including cross-origin CDN CSS) via network responses.
  const onResponse = async (response) => {
    try {
      const url = response.url();
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('text/css') && !/\.css(\?|$)/i.test(url)) return;
      if (cssStore.has(url)) return;
      // don't buffer huge bodies just to throw most of them away
      const declared = parseInt(response.headers()['content-length'] || '0', 10);
      if (declared > 2 * 1024 * 1024) return;
      const body = await response.text();
      if (!body || !body.length) return;
      // a .css URL serving JS/HTML (no '{' early) is regex noise, not CSS
      if (!body.slice(0, 4096).includes('{')) return;
      cssStore.set(url, body.slice(0, 500000));
    } catch {
      /* body unavailable / cross-origin opaque — ignore */
    }
  };
  page.on('response', onResponse);

  const result = { url: pageUrl, slug, screenshots: { scrollFrames: [] }, data: null, skipped: [] };
  const timeLeft = () => deadline - Date.now();
  const briefErr = (e) => String(e).split('\n')[0].slice(0, 140);

  try {
    await page.setViewportSize(BREAKPOINTS.desktop);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
    // bounded settle
    await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_TIMEOUT }).catch(() => {});

    // trigger lazy-load + scroll animations
    await autoScrollDance(page).catch(() => {});
    await page.waitForTimeout(POST_SCROLL_SETTLE);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // desktop viewport screenshot (at top)
    try {
      await page.screenshot({ path: path.join(pageDir, 'desktop.png') });
      result.screenshots.desktop = `pages/${slug}/desktop.png`;
    } catch (e) {
      result.skipped.push(`desktop.png: ${briefErr(e)}`);
    }

    // in-page extraction at desktop (self-truncates at ~15s; outer race is a
    // backstop since evaluate ignores context default timeouts)
    let data = {};
    try {
      data = await withTimeout(page.evaluate(pageExtract), 25000, 'in-page extraction');
    } catch (e) {
      data = { extractionError: String(e).slice(0, 200) };
    }

    // fold cross-origin CSS findings into this page's data
    // (each stylesheet body is parsed once, cached by URL)
    const cssKeyframes = [];
    const cssProps = {};
    const cssFontFaces = new Set();
    const cssHovers = [];
    let cssScrollTimeline = false;
    for (const [cssUrl, cssText] of cssStore) {
      const parsed = parseCssBody(cssUrl, cssText);
      cssKeyframes.push(...parsed.keyframes);
      Object.assign(cssProps, parsed.props);
      for (const f of parsed.fontFaces) cssFontFaces.add(f);
      cssHovers.push(...parsed.hovers);
      cssScrollTimeline = cssScrollTimeline || parsed.scrollTimeline;
    }
    // scroll-timeline usage often lives only in cross-origin CSS
    data.scrollEvidence = data.scrollEvidence || { scrollTimeline: false, aosAttrs: false };
    data.scrollEvidence.scrollTimeline = data.scrollEvidence.scrollTimeline || cssScrollTimeline;
    // merge keyframes (dedupe by name, prefer in-page cssText)
    const kfByName = new Map();
    for (const kf of data.keyframes || []) kfByName.set(kf.name, kf);
    for (const kf of cssKeyframes) if (!kfByName.has(kf.name)) kfByName.set(kf.name, kf);
    data.keyframes = [...kfByName.values()];
    // merge design tokens (in-page wins)
    data.designTokens = { ...cssProps, ...(data.designTokens || {}) };
    data.cssFontFaces = [...cssFontFaces].slice(0, 40);

    // merge hover styles from same-origin sheets (already in data.hoverStyles)
    // with cross-origin ones, dedupe by selector, prioritize button/link/card.
    const hoverBySel = new Map();
    for (const h of data.hoverStyles || []) hoverBySel.set(h.selector, h);
    for (const h of cssHovers) if (!hoverBySel.has(h.selector)) hoverBySel.set(h.selector, h);
    const hoverPriority = (sel) => (/button|btn|\ba\b|link|card|nav|cta/i.test(sel) ? 0 : 1);
    data.hoverStyles = [...hoverBySel.values()]
      .sort((a, b) => hoverPriority(a.selector) - hoverPriority(b.selector))
      .slice(0, 40);

    // attach NOW — a later screenshot failure must not discard extracted data
    result.data = data;
    result.title = (data.meta && data.meta.title) || null;

    // remaining screenshots: failures/timeouts here degrade screenshots only
    try {
      for (const bp of ['tablet', 'mobile']) {
        if (timeLeft() < 5000) {
          result.skipped.push(`${bp}.png: runtime budget exhausted`);
          continue;
        }
        await page.setViewportSize(BREAKPOINTS[bp]);
        await page.waitForTimeout(BREAKPOINT_SETTLE);
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await page.screenshot({ path: path.join(pageDir, `${bp}.png`) });
        result.screenshots[bp] = `pages/${slug}/${bp}.png`;
      }

      // back to desktop for full page + scroll frames
      await page.setViewportSize(BREAKPOINTS.desktop);
      await page.waitForTimeout(BREAKPOINT_SETTLE);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      if (timeLeft() < 5000) {
        result.skipped.push('fullpage.png: runtime budget exhausted');
      } else {
        try {
          // fullPage can throw on very tall pages (>32767px render limit)
          await page.screenshot({ path: path.join(pageDir, 'fullpage.png'), fullPage: true });
          result.screenshots.fullpage = `pages/${slug}/fullpage.png`;
        } catch (e) {
          result.skipped.push(`fullpage.png: ${briefErr(e)}`);
        }
      }

      // scroll frames (skip if page shorter than 2 viewports)
      const dims = await page
        .evaluate(() => ({ vh: window.innerHeight, sh: document.documentElement.scrollHeight }))
        .catch(() => null);
      if (dims && scrollFrames > 0 && dims.sh >= dims.vh * 2) {
        for (let i = 0; i < scrollFrames; i++) {
          const y = i * dims.vh;
          if (y >= dims.sh) break;
          if (timeLeft() < 3000) {
            result.skipped.push(`scroll frames ${i + 1}+: runtime budget exhausted`);
            break;
          }
          await page.evaluate((yy) => window.scrollTo(0, yy), y).catch(() => {});
          await page.waitForTimeout(SCROLL_FRAME_SETTLE);
          const name = `scroll-${String(i + 1).padStart(2, '0')}.png`;
          await page.screenshot({ path: path.join(pageDir, name) });
          result.screenshots.scrollFrames.push(`pages/${slug}/${name}`);
        }
      }
    } catch (e) {
      result.skipped.push(`screenshots: ${briefErr(e)}`);
    }
  } finally {
    page.off('response', onResponse);
    await page.close().catch(() => {});
  }
  return result;
}

// ---------------------------------------------------------------------------
// Collect crawl candidates from the start page.
// ---------------------------------------------------------------------------
// Navigates to the start URL (throws if unreachable — doubles as the
// reachability probe) and returns collected links plus the FINAL post-redirect
// URL, whose origin is what every collected a.href resolves against.
async function collectLinks(context, startUrl) {
  const page = await context.newPage();
  try {
    await page.setViewportSize(BREAKPOINTS.desktop);
    await page.goto(startUrl.href, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_TIMEOUT }).catch(() => {});
    const finalUrl = page.url();
    const links = await page
      .evaluate(() => {
        const out = [];
        const collect = (root, zone) => {
          if (!root) return;
          root.querySelectorAll('a[href]').forEach((a) => {
            out.push({ href: a.href, zone });
          });
        };
        document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]').forEach((el) => collect(el, 'nav'));
        document.querySelectorAll('footer, [role="contentinfo"]').forEach((el) => collect(el, 'footer'));
        collect(document.querySelector('main') || document.body, 'main');
        return out;
      })
      .catch(() => []);
    return { links, finalUrl };
  } finally {
    await page.close().catch(() => {});
  }
}

function buildCrawlList(startUrl, rawLinks, maxPages) {
  const origin = startUrl.origin;
  const startNorm = normalizeHref(startUrl.href, origin);
  const startPath = startNorm ? startNorm.pathname : '/';

  // distinct templates can slugify identically (/products/shoes vs
  // /products-shoes) — suffix duplicates so outputs never clobber each other
  const usedSlugs = new Set();
  const uniqueSlug = (base) => {
    let s = base;
    for (let n = 2; usedSlugs.has(s); n++) s = `${base}-${n}`;
    usedSlugs.add(s);
    return s;
  };

  const seenPaths = new Set([startPath]);
  const seenTemplates = new Set([templateKey(startPath)]);
  const pages = [{ url: origin + startPath, slug: uniqueSlug(slugFor(startPath)) }];

  // zone priority: nav first, then footer, then main
  const zoneRank = { nav: 0, footer: 1, main: 2 };
  const ordered = rawLinks
    .map((l, idx) => ({ ...l, idx }))
    .sort((a, b) => (zoneRank[a.zone] - zoneRank[b.zone]) || (a.idx - b.idx));

  for (const link of ordered) {
    if (pages.length >= maxPages) break;
    const u = normalizeHref(link.href, origin);
    if (!u || u.origin !== origin) continue;
    if (seenPaths.has(u.pathname)) continue;
    const tkey = templateKey(u.pathname);
    if (seenTemplates.has(tkey)) continue; // template already represented
    seenPaths.add(u.pathname);
    seenTemplates.add(tkey);
    pages.push({ url: u.origin + u.pathname, slug: uniqueSlug(slugFor(u.pathname)) });
  }
  return pages.slice(0, maxPages);
}

// ---------------------------------------------------------------------------
// Aggregate per-page data into scan.json
// ---------------------------------------------------------------------------
function truncCss(s) {
  return typeof s === 'string' && s.length > 2000 ? s.slice(0, 2000) + ' /* …truncated */' : s;
}

function buildAggregate(startUrl, pageResults, truncated) {
  const mergedTokens = {};
  const fontMap = new Map();
  const colorMap = new Map();
  const kfMap = new Map();
  const waapiMap = new Map();
  const scrollEvidence = { scrollTimeline: false, aosAttrs: false, scrollLibrary: null };
  const transMap = new Map();
  const hoverMap = new Map();
  const libMerged = {};
  const compMerged = {};
  const fontLinks = new Set();
  const fontFaces = new Set();

  const pagesSummary = [];

  for (const pr of pageResults) {
    const d = pr.data || {};
    Object.assign(mergedTokens, d.designTokens || {});

    for (const f of (d.typography && d.typography.fonts) || []) {
      const key = `${f.family}|${f.weight}|${f.style}`;
      if (!fontMap.has(key)) fontMap.set(key, f);
    }
    for (const l of (d.typography && d.typography.fontLinks) || []) fontLinks.add(l);
    for (const ff of d.cssFontFaces || []) fontFaces.add(ff);

    for (const c of d.colorPalette || []) {
      if (!colorMap.has(c.color)) colorMap.set(c.color, { color: c.color, count: 0, role: c.role, roles: { text: 0, bg: 0, border: 0, ctaBg: 0 } });
      const rec = colorMap.get(c.color);
      rec.count += c.count;
      if (c.roles) {
        rec.roles.text += c.roles.text || 0;
        rec.roles.bg += c.roles.bg || 0;
        rec.roles.border += c.roles.border || 0;
        rec.roles.ctaBg += c.roles.ctaBg || 0;
      }
    }

    for (const kf of d.keyframes || []) {
      if (!kfMap.has(kf.name)) kfMap.set(kf.name, { name: kf.name, cssText: truncCss(kf.cssText) });
    }

    // merge waapi across pages by identity key, summing instance counts
    for (const a of d.waapiAnimations || []) {
      const key = `${a.animationName || ''}|${a.target}|${a.timing ? a.timing.duration : ''}`;
      const existing = waapiMap.get(key);
      if (existing) existing.count += a.count || 1;
      else waapiMap.set(key, { ...a, count: a.count || 1 });
    }

    if (d.scrollEvidence) {
      scrollEvidence.scrollTimeline = scrollEvidence.scrollTimeline || !!d.scrollEvidence.scrollTimeline;
      scrollEvidence.aosAttrs = scrollEvidence.aosAttrs || !!d.scrollEvidence.aosAttrs;
    }

    for (const t of d.transitions || []) {
      const key = `${t.selector}|${t.property}|${t.duration}`;
      if (!transMap.has(key)) transMap.set(key, t);
    }

    for (const h of d.hoverStyles || []) {
      if (!hoverMap.has(h.selector)) hoverMap.set(h.selector, h);
    }

    // merge libraries: OR booleans, keep truthy scalar values, union arrays
    const libs = d.animationLibraries || {};
    for (const [k, v] of Object.entries(libs)) {
      if (Array.isArray(v)) {
        const set = new Set(libMerged[k] || []);
        v.forEach((x) => set.add(x));
        libMerged[k] = [...set];
      } else if (typeof v === 'boolean') {
        libMerged[k] = !!libMerged[k] || v;
      } else if (v != null) {
        if (libMerged[k] == null) libMerged[k] = v;
      }
    }

    // merge components: sum numeric counts, keep first signatures set
    const comps = d.components || {};
    for (const [k, v] of Object.entries(comps)) {
      if (typeof v === 'number') compMerged[k] = (compMerged[k] || 0) + v;
      else if (v && typeof v === 'object' && 'count' in v) {
        if (!compMerged[k]) compMerged[k] = { count: 0, signatures: v.signatures || [] };
        compMerged[k].count += v.count || 0;
        if ((!compMerged[k].signatures || !compMerged[k].signatures.length) && v.signatures) compMerged[k].signatures = v.signatures;
      }
    }

    pagesSummary.push({
      url: pr.url,
      slug: pr.slug,
      title: pr.title || null,
      screenshots: pr.screenshots,
      ...(pr.skipped && pr.skipped.length ? { skipped: pr.skipped } : {}),
      summary: {
        colors: (d.colorPalette || []).length,
        keyframes: (d.keyframes || []).length,
        waapiAnimations: (d.waapiAnimations || []).length,
        transitions: (d.transitions || []).length,
        fonts: ((d.typography && d.typography.fonts) || []).length,
      },
    });
  }

  const colorPalette = [...colorMap.values()]
    .map((c) => {
      let role = 'text';
      if (c.roles.ctaBg > 0 && c.roles.ctaBg * 2 >= c.roles.bg) role = 'accent/cta';
      else if (c.roles.bg >= c.roles.text && c.roles.bg >= c.roles.border) role = 'bg';
      else if (c.roles.border >= c.roles.text && c.roles.border >= c.roles.bg) role = 'border';
      return { color: c.color, count: c.count, role };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 24);

  // most interesting WAAPI: prefer named + longer durations, cap 30 (deduped)
  const waapiInteresting = [...waapiMap.values()]
    .sort((a, b) => {
      const da = (a.timing && typeof a.timing.duration === 'number' ? a.timing.duration : 0) + (a.animationName ? 1e6 : 0);
      const db = (b.timing && typeof b.timing.duration === 'number' ? b.timing.duration : 0) + (b.animationName ? 1e6 : 0);
      return db - da;
    })
    .slice(0, 30);

  scrollEvidence.scrollLibrary = libMerged.scrollTrigger
    ? 'gsap-scrolltrigger'
    : libMerged.aos
      ? 'aos'
      : libMerged.lenis
        ? 'lenis'
        : libMerged.locomotiveScroll
          ? 'locomotive'
          : null;

  const startResult = pageResults[0] || {};
  const layout = (startResult.data && startResult.data.layout) || {};
  const meta = (startResult.data && startResult.data.meta) || {};

  // computed per-role typography: start page's roles + material diffs elsewhere
  const startTypo = (startResult.data && startResult.data.typography && startResult.data.typography.elements) || {};
  const typoDiffs = [];
  for (const pr of pageResults.slice(1)) {
    const els = (pr.data && pr.data.typography && pr.data.typography.elements) || {};
    for (const [role, st] of Object.entries(els)) {
      const base = startTypo[role];
      const differs =
        !base ||
        Math.abs(parseFloat(st.fontSize) - parseFloat(base.fontSize)) > 2 ||
        st.fontFamily !== base.fontFamily ||
        st.fontWeight !== base.fontWeight;
      if (differs) typoDiffs.push({ page: pr.slug, role, ...st });
    }
  }
  const typography = {
    roles: startTypo,
    ...(typoDiffs.length ? { pageDiffs: typoDiffs.slice(0, 20) } : {}),
  };

  return {
    url: startUrl.href,
    scannedAt: new Date().toISOString(),
    tool: 'design-scan',
    truncated: !!truncated,
    pages: pagesSummary,
    designTokens: mergedTokens,
    fonts: {
      loaded: [...fontMap.values()].slice(0, 60),
      links: [...fontLinks].slice(0, 20),
      fontFaces: [...fontFaces].slice(0, 40),
    },
    typography,
    colorPalette,
    animations: {
      libraries: libMerged,
      keyframes: [...kfMap.values()],
      waapi: waapiInteresting,
      transitions: [...transMap.values()].slice(0, 40),
      hoverStyles: [...hoverMap.values()].slice(0, 40),
      scrollEvidence,
    },
    layout,
    components: compMerged,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.url) {
    fail('Missing URL. Usage: node scripts/scan.mjs <url> [--out <dir>] [--max-pages <n>] [--scroll-frames <n>]');
  }
  const startUrl = normalizeInputUrl(args.url);
  if (!startUrl) {
    fail(`Invalid URL: "${args.url}". Provide an http(s) URL, e.g. https://example.com`);
  }

  // Crawl URLs are rebuilt from origin+pathname, which drops userinfo — pass
  // basic-auth via the browser context instead so every request carries it.
  const httpCredentials = startUrl.username
    ? { username: decodeURIComponent(startUrl.username), password: decodeURIComponent(startUrl.password || '') }
    : undefined;
  startUrl.username = '';
  startUrl.password = '';

  const outDir = args.out || path.join('design-scan-output', startUrl.hostname);
  const absOut = path.resolve(outDir);

  // Load playwright, giving an actionable error if missing.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fail('Playwright is not installed. From the skill dir run: npm install && npx playwright install chromium');
  }

  log(`\ndesign-scan → ${startUrl.href}`);
  log(`output: ${absOut}\n`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    fail(`Could not launch Chromium (${String(e).split('\n')[0]}). From the skill dir run: npm install && npx playwright install chromium`);
  }

  // Graceful shutdown
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('\n⚠ interrupted — closing browser…');
    try {
      await browser.close();
    } catch {}
    process.exit(130);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: BREAKPOINTS.desktop,
    deviceScaleFactor: 1,
    ...(httpCredentials ? { httpCredentials } : {}),
  });
  context.setDefaultTimeout(GOTO_TIMEOUT);

  const cssStore = new Map(); // url -> css text, shared across pages (CSS is usually shared)
  const deadline = START + HARD_RUNTIME_CAP;

  // Discover pages — this navigation is also the reachability check.
  log('▸ discovering pages…');
  let discovery;
  try {
    discovery = await collectLinks(context, startUrl);
  } catch (e) {
    await browser.close().catch(() => {});
    fail(`Page unreachable: ${startUrl.href} (${String(e).split('\n')[0].replace(/^.*Error:\s*/, '')})`);
  }
  // Redirects (http→https, apex→www) change the origin that collected links
  // resolve against — crawl from the FINAL origin, not the user-typed one.
  const canonicalStart = normalizeInputUrl(discovery.finalUrl) || startUrl;
  const crawl = buildCrawlList(canonicalStart, discovery.links, args.maxPages);
  log(`  found ${discovery.links.length} links → scanning ${crawl.length} page(s) (${crawl.map((p) => p.slug).join(', ')})\n`);

  const pageResults = [];
  let truncated = false;
  for (let i = 0; i < crawl.length; i++) {
    if (Date.now() - START > HARD_RUNTIME_CAP) {
      log(`\n⚠ runtime cap (~${Math.round(HARD_RUNTIME_CAP / 1000)}s) reached — stopping after ${pageResults.length} page(s).`);
      truncated = true;
      break;
    }
    const { url, slug } = crawl[i];
    const pathLabel = new URL(url).pathname;
    const t0 = Date.now();
    try {
      const res = await scanPage(context, url, slug, absOut, args.scrollFrames, cssStore, deadline);
      pageResults.push(res);
      // write per-page data.json (kept sane in size)
      await writePageData(absOut, slug, res);
      const d = res.data || {};
      const bp = ['desktop', 'tablet', 'mobile', 'fullpage'].filter((k) => res.screenshots[k]).length;
      const nf = (res.screenshots.scrollFrames || []).length;
      const nk = (d.keyframes || []).length;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const skipNote = res.skipped && res.skipped.length ? `, ${res.skipped.length} skipped` : '';
      log(
        `▸ [${i + 1}/${crawl.length}] ${pathLabel} … ${bp} breakpoints, ${nf} scroll frames, ${nk} keyframes${skipNote} (${secs}s)`
      );
    } catch (e) {
      log(`▸ [${i + 1}/${crawl.length}] ${pathLabel} … FAILED: ${String(e).split('\n')[0]}`);
    }
  }

  if (pageResults.length === 0) {
    await browser.close().catch(() => {});
    fail('No pages could be scanned.');
  }

  // Aggregate (canonical post-redirect URL — that's what was actually scanned)
  const aggregate = buildAggregate(canonicalStart, pageResults, truncated);
  await writeJsonCapped(path.join(absOut, 'scan.json'), aggregate, 400 * 1024);

  await browser.close().catch(() => {});
  process.removeListener('SIGINT', shutdown);
  process.removeListener('SIGTERM', shutdown);

  // Final summary
  printSummary(absOut, aggregate, crawl.length);
}

async function writePageData(absOut, slug, res) {
  const data = res.data || {};
  const payload = {
    url: res.url,
    slug: res.slug,
    title: res.title || null,
    screenshots: res.screenshots,
    ...(res.skipped && res.skipped.length ? { skipped: res.skipped } : {}),
    ...data,
  };
  await writeJsonCapped(path.join(absOut, 'pages', slug, 'data.json'), payload, 300 * 1024);
}

// Write JSON; if it exceeds cap, progressively trim the heaviest arrays.
async function writeJsonCapped(file, obj, cap) {
  let json = JSON.stringify(obj, null, 2);
  if (json.length > cap) {
    // trim likely-heavy arrays and retry
    const trimPaths = [
      ['animations', 'keyframes'],
      ['keyframes'],
      ['animations', 'waapi'],
      ['waapiAnimations'],
      ['colorPalette'],
      ['animations', 'transitions'],
      ['transitions'],
    ];
    for (const p of trimPaths) {
      let node = obj;
      for (let i = 0; i < p.length - 1; i++) node = node && node[p[i]];
      const key = p[p.length - 1];
      if (node && Array.isArray(node[key])) {
        node[key] = node[key].slice(0, Math.max(5, Math.floor(node[key].length / 2)));
      }
      json = JSON.stringify(obj, null, 2);
      if (json.length <= cap) break;
    }
    if (obj && typeof obj === 'object') obj.sizeCapped = true;
    json = JSON.stringify(obj, null, 2);
  }
  await writeFile(file, json);
  return json.length;
}

function printSummary(absOut, agg, requestedPages) {
  const nColors = agg.colorPalette.length;
  const nFonts = agg.fonts.loaded.length;
  const nKf = agg.animations.keyframes.length;
  const libs = Object.entries(agg.animations.libraries)
    .filter(([k, v]) => v === true)
    .map(([k]) => k);
  const scriptLibs = agg.animations.libraries.scriptSrcMatches || [];

  log('\n' + '─'.repeat(60));
  log(`✔ scan complete — ${agg.pages.length} page(s) in ${elapsed()}s`);
  log('─'.repeat(60));
  log(`${absOut}/`);
  log(`  scan.json`);
  log(`  pages/`);
  for (const p of agg.pages) {
    const nf = (p.screenshots.scrollFrames || []).length;
    log(`    ${p.slug}/  (desktop, tablet, mobile, fullpage, ${nf} scroll frames)`);
  }
  log('');
  log(`  pages scanned:  ${agg.pages.length}`);
  log(`  colors:         ${nColors}`);
  log(`  fonts:          ${nFonts}`);
  log(`  keyframes:      ${nKf}`);
  log(`  waapi anims:    ${agg.animations.waapi.length}`);
  log(`  transitions:    ${agg.animations.transitions.length}`);
  log(`  libraries:      ${libs.length ? libs.join(', ') : '(none detected)'}`);
  if (scriptLibs.length) log(`  script CDNs:    ${scriptLibs.join(', ')}`);
  if (agg.truncated) log(`  note:           runtime cap hit — output is partial`);
  log('');
  log(`Next: read scan.json and the screenshots to write design.md`);
  log('');
}

// Run only when invoked directly (`node scripts/scan.mjs …`); importing the
// module (e.g. to test the CSS parsers) must not start a scan.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    // realpath: argv[1] may be a symlink while import.meta.url is resolved
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    fail(`Unexpected error: ${String(e && e.stack ? e.stack.split('\n')[0] : e)}`);
  });
}

export { extractKeyframesFromCss, extractCustomPropsFromCss, extractFontFacesFromCss, extractHoverFromCss, parseCssBody, buildCrawlList };
