# design-scan

A Claude Code skill that turns a live website into `design.md` — a replication-grade spec of its look and motion. Pipeline: crawl (template-deduped, up to ~6 pages) → screenshot 3 breakpoints + full-page + scroll frames → extract computed styles, color palette, CSS `@keyframes`, and live `getAnimations()` data → Claude reads it all and writes `design.md`.

## Install

Requires **Node 18+** and **Claude Code**. One command, in the project where you want the skill:

```
npx skills add Shawnchee/design-scan
```

Or add `-g` to install it user-wide, so it's available in every project:

```
npx skills add Shawnchee/design-scan -g
```

That's it — **no other setup**. You don't need to install Playwright or anything else yourself: the first time you run the skill, Claude installs the scanner's dependencies for you (a one-time ~300MB Chromium download, takes a minute or two). Every run after that starts instantly.

<details>
<summary>Manual install (git clone) and optional pre-install</summary>

Install without the `skills` CLI:

```
git clone https://github.com/Shawnchee/design-scan
ln -s "$PWD/design-scan/skills/design-scan" ~/.claude/skills/design-scan
```

If you'd rather not wait on the first run, pre-install the dependencies yourself:

```
cd ~/.claude/skills/design-scan   # or .claude/skills/design-scan in your project
npm install
npx playwright install chromium
```

</details>

## Use

Start Claude Code and give it a URL:

```
/design-scan https://linear.app
```

Claude runs the bundled Playwright scanner (typically 1–4 minutes: it crawls up to ~6 pages, screenshots each at 3 breakpoints plus full-page and scroll frames, and extracts the design data), then reads the results and writes `design.md` into your current project, alongside a `design-scan-output/` folder with the raw screenshots and JSON.

Plain-language asks work too — "scan stripe.com and make a design.md" or "replicate this website's design: <url>".

## What you get

```
design.md                          # the spec Claude writes, in your project root
design-scan-output/<hostname>/
  scan.json                        # aggregate: tokens, fonts, computed typography, palette, animations, layout, components
  pages/<slug>/
    desktop.png  tablet.png  mobile.png  fullpage.png
    scroll-01.png … scroll-NN.png
    data.json                      # full per-page detail
```

`design.md` contains: Overview, Layout System, Typography (exact families/sizes/weights), Color Palette (exact hex + usage counts + design tokens), Components (with computed styles), Animation & Motion (per-animation duration/delay/easing/keyframes — real values), Responsive Behavior, Assets & References, and Implementation Notes (e.g. a Tailwind config mapping).

## How it works

The scanner reads **computed styles** and calls **`getAnimations()`** in the page rather than guessing motion from pixels. That means real numbers: actual font families and sizes, exact hex colors with usage counts, CSS `@keyframes` and Web Animations API keyframes with their true offsets, durations, and easings, plus transitions and `:hover` rules pulled from the stylesheets. Screenshots at 3 breakpoints (desktop, tablet 768px, mobile 390px), a full-page capture, and scroll frames give Claude the visual hierarchy and feel; the extracted data gives it the values. The result is a spec that can be reproduced, not approximated.

## Running the scanner standalone

The scanner is a plain Node script, so any agent (Codex, etc.) or a human can run it directly:

```
node skills/design-scan/scripts/scan.mjs <url> [--out <dir>] [--max-pages <n>] [--scroll-frames <n>]
```

Defaults: `--out ./design-scan-output/<hostname>`, `--max-pages 6`, `--scroll-frames 8`. Point your agent at the resulting `scan.json` and the screenshots under `pages/<slug>/` and ask it to write the spec.

## Limitations

- **Bot-protected sites** (Cloudflare challenges, aggressive WAFs) may block headless Chrome; try a specific subpage or a different URL.
- **Canvas / WebGL animations** are captured only visually in screenshots — their internals aren't extractable.
- **Hover states** come from parsing CSS rules, not from simulating a real pointer, so JS-driven hover effects may be missed.
- **JS-set inline animation values** applied imperatively can be missed if they aren't live in `getAnimations()` at capture time.

## Troubleshooting

- **Playwright / Chromium missing** — run `npx playwright install chromium` from the skill directory.
- **Timeouts** — slow or heavy sites: retry, or lower `--max-pages`, or target a lighter subpage.
- **Empty keyframes** — the scanner mines cross-origin CSS too (it captures `text/css` responses off the network), so `@keyframes` from CDN-served stylesheets are normally found. They only come back empty when the CSS response body is unreadable (opaque responses) — `getAnimations()` (WAAPI) data still lands in that case.
