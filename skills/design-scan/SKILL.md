---
name: design-scan
description: >-
  Scans a live website and produces design.md — a replication-grade spec of its
  look and motion. Runs a bundled Playwright crawler that template-dedupes and
  visits up to ~6 pages, captures screenshots at 3 breakpoints plus full-page and
  scroll frames, and extracts structured design data: CSS custom properties,
  fonts, computed typography, a color palette with usage counts, CSS @keyframes,
  Web Animations API animations with real keyframes/durations/easings,
  transitions, :hover rules, animation-library detection (GSAP, Framer Motion,
  Lottie, AOS, Lenis), layout metrics, and a component inventory. Claude then
  reads the screenshots plus JSON and writes design.md. Trigger on "design scan",
  "/design-scan <url>", "replicate this website's design", "scan <url> and make a
  design.md", "clone this site's look", or "extract the design system from <url>".
---

# design-scan

Turn a live URL into `design.md`, a spec detailed enough to replicate the site's visual design and motion. Follow these steps exactly.

## 1. Parse the URL

Read the target URL from the user's args. If none is present, ask for it and stop. Accept bare hostnames and normalize to `https://` if no scheme is given.

## 2. Dependency check (one-time)

Resolve the **skill dir** = the directory containing this SKILL.md. Do NOT assume it equals the current working directory; the user runs the skill from their own project.

If `<skill-dir>/node_modules` does not exist, install from the skill dir:

```
npm install --prefix <skill-dir>
npx --prefix <skill-dir> playwright install chromium
```

Tell the user this is a one-time setup and that the Chromium download is ~300MB, so it may take a minute. Skip this step entirely if `node_modules` already exists.

## 3. Run the scan

From the skill dir, run:

```
node <skill-dir>/scripts/scan.mjs <url> --out <cwd>/design-scan-output/<hostname>
```

`<hostname>` is the URL's host (e.g. `linear.app`). `<cwd>` is the user's project directory, not the skill dir — output belongs in the user's project. Relay progress to the user as it streams; typical runtime is 1–4 minutes.

If the script exits non-zero, show its one-line error and the likely fix:
- **Bot-blocked / challenge page** (Cloudflare, empty content, timeout on load): suggest trying a different URL or a specific subpage that isn't gated.
- **Unreachable URL** (DNS/connection error): confirm the URL is correct and public.
- **Missing Chromium** (Playwright error about a missing browser): run `npx --prefix <skill-dir> playwright install chromium` and retry.

## 4. Read the results — with token discipline

The scan writes a lot; do NOT read all of it. Read in this order and stop when you have enough:

1. **`<out>/scan.json` first — always.** It is the aggregate: `pages` list, `designTokens`, `fonts`, `typography` (computed per-role type styles from the home page — use this for real rendered sizes; design tokens alone can understate viewport-scaled headings), `colorPalette`, `animations` (`libraries`, `keyframes`, `waapi`, `transitions`, `hoverStyles`, `scrollEvidence`), `layout`, `components`, `meta`. This is your primary source of truth for all numeric values. Reading notes: `waapi` entries are deduped with a `count` field — a high count means the animation is a repeated pattern, not a one-off. `colorPalette` roles are mechanical (text/bg/border/accent-cta) — identify the brand/accent colors yourself from saturated values and the button signatures; don't transcribe roles blindly.
2. **Screenshots, in priority order:**
   - Home page: read `desktop.png`, `tablet.png`, `mobile.png`, and `fullpage.png` — always (the Responsive section needs all three breakpoints).
   - Every other page: read `desktop.png` only.
   - Scroll frames (`scroll-01.png` …): read 2–3 representative frames (early / middle / late), **only for the home page**, and **only if** `scan.json` shows actual scroll-triggered motion: `animations.scrollEvidence` has `scrollTimeline`/`aosAttrs` true or a `scrollLibrary`, or a scroll library (AOS, GSAP, Lenis, Locomotive) appears in `animations.libraries`. Non-empty `keyframes`/`waapi` alone is **not** evidence — most sites have hover/loader animations that never fire on scroll. When in doubt, skip.
3. **Never** read every screenshot of every page. **Never** open `pages/<slug>/data.json` unless `scan.json` is missing a specific detail you need for one section — then read only that page's `data.json`.

## 5. Write design.md

Write to `<cwd>/design.md`. If a `design.md` already exists there, ask before overwriting. Follow the template below verbatim in structure.

**Quality bar (non-negotiable):**
- Every animation entry cites **real values from scan.json** — duration, delay, easing, keyframe offsets. Never write "smooth fade" or "subtle slide" without the numbers behind it.
- The color palette uses **exact hex values** with usage roles and counts from `colorPalette`.
- Typography names **exact families, weights, and sizes** from `fonts` and the computed type data.
- Where `scan.json` and the screenshots disagree, **trust `scan.json` for values** (colors, sizes, timings) and **the screenshots for hierarchy and feel** (what's prominent, the overall mood).

### design.md template

````markdown
# Design Spec: <site>

## Overview
One paragraph: brand feel, visual density, dark vs light, overall personality.

## Layout System
Max content widths; grid vs flex patterns and column counts; header behavior
(sticky? transparent-to-solid on scroll?); vertical rhythm and the spacing scale
between sections.

## Typography
| Role | Family | Size | Weight | Line height | Letter spacing |
|------|--------|------|--------|-------------|----------------|
| Display / H1 | … | … | … | … | … |
| Heading / H2 | … | … | … | … | … |
| Body | … | … | … | … | … |
| Caption / small | … | … | … | … | … |

Font loading source (Google Fonts, self-hosted @font-face, system stack).

## Color Palette
| Swatch (hex) | Role | Usage count |
|--------------|------|-------------|
| #… | Background | … |
| #… | Text | … |
| #… | Accent / brand | … |

### Design tokens (CSS custom properties)
| Token | Value | Role |
|-------|-------|------|
| --… | … | … |

## Components
For each key component (nav, hero, buttons, cards, footer, …):
- **Name** — description; key computed styles (padding, radius, border, shadow,
  background); which screenshot shows it (path).

## Animation & Motion
Libraries detected: <list from animations.libraries, or "none — CSS only">.

Per animation:
- **Name / target** — trigger (load | scroll | hover); duration; delay; easing;
  keyframes summary with real offsets (e.g. `0%: opacity 0, translateY 24px →
  100%: opacity 1, translateY 0`).

Hover states: what changes on :hover and the transition used.
Transition conventions: default duration/easing applied across interactive elements.

## Responsive Behavior
What changes at 768px (tablet) and 390px (mobile) based on the tablet/mobile
screenshots — nav collapse, column reflow, type scaling, hidden elements.

## Assets & References
- Screenshots: paths under `design-scan-output/<hostname>/pages/…`
- og:image, favicon (from meta).

## Implementation Notes
Suggested stack mapping — e.g. a Tailwind config snippet wiring the tokens above,
and which animation library best replicates the observed motion.
````

## 6. Report and offer next step

Tell the user:
- `design.md` was written at `<cwd>/design.md`.
- Screenshots and raw data live in `<cwd>/design-scan-output/<hostname>/` for reference.
- Offer: "Want me to scaffold a project that implements this design.md?"
