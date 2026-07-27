# Token Drift Report (Phase 1.3, computed styles at 390px across all screens)

## Measured state

**Font sizes: 28 distinct computed values** (top by element count):
16, 13.6, 11.52, 14.4, 17.6, 16.8, 12.8, 16.32, 19.2, 12, 12.48, 26, 18.72, 20 … px.
Root cause: `.muted { font-size: 0.85em }` and other `em` sizes compound when nested
(16 → 13.6 → 11.56; 19.2 → 16.32 → …). Nothing intends a 12.48px size; the cascade invents it.

**Font weights: 4 distinct** (400×948, 700×68, 600×62, 500×48). Bar is 3 — the 48 uses of 500
(walk chip, some chips) should collapse into 400 or 600.

**Radii:** 12 (×56), 16 (×52), 999 (×40), 50% (×22) — on-scale — plus drift: **14px** (when-row
input, ×10), **18px 18px 0 0** (sheet, ×2), **2px** (focus-visible, ×2).

**Spacing off the 4-grid** (padding components): 10px (×110), 6px (×94), 18px (×80), 14px (×54),
11px (×16), 7px (×16), 13px (×10), 5px (×4). The grid exists (4/8/12/16 dominate) but a third of
padded elements sit off it.

**Colors not traceable to a token:**
- `rgb(238,238,238)` (#eee, ×36) — `var(--text, #eee)` fallback; **--text does not exist** in mangonese.css
- `rgb(34,34,34)` (#222, ×24) — light-theme hardcode in `.mode-toggle.active` override
- `var(--bg, #141414)` on `.endpoint-stack .swap-btn` — **--bg does not exist**; renders #141414
- assorted rgba(255,255,255,x) hairlines — acceptable as alpha overlays but should become
  `--border-subtle` / `--border-strong`

**Contrast (token-level):** dark-mode `--text-muted` (#4a5a6a) yields 2.5:1 on `--bg-primary`
(#0d1117) and 2.67:1 on `--bg-surface`. Fails WCAG AA for all text sizes in use. Secondary
(#8a9aa8) passes at ~5.4:1. This is a mangonese.css issue affecting every app that uses
`.muted` for readable copy.

## Proposed canonical set

- **Font sizes (rem):** 0.75 (12) captions/chips · 0.875 (14) secondary · 1 (16) body ·
  1.125 (18) card titles · 1.25 (20) section headers · 1.625 (26) primary clocks.
  `.muted` sets color only; a separate `.text-sm` opts into 14.
- **Weights:** 400 / 600 / 700.
- **Spacing:** 4 / 8 / 12 / 16 / 20 / 24; **one 16px content rail** (main gutter 16, card padding 16).
- **Radii:** 12 (inputs, chips-square), 16 (cards, sheets), 999 (pills), 50% (round buttons).
  Focus ring radius inherits the element.
- **Colors:** only mangonese tokens; replace `--bg`→`--bg-primary`, `--text`→`--text-primary`;
  hairlines → `--border-subtle`/`--border-strong`.
- **Token change proposal for mangonese.css:** dark `--text-muted` from #4a5a6a to **#7e8fa0**
  (4.6:1 on #0d1117) — visually still muted, legally legible. To be rolled out shared-side,
  not overridden per-app.

## Violations by file (approximate, from grep + computed-style attribution)

| File | Off-scale sizes | Off-grid paddings | Phantom/hardcoded colors | Off-scale radii |
|---|---|---|---|---|
| css/styles.css (app) | ~20 declarations (em cascade + px) | ~30 declarations | 4 (`--bg`, `--text`, #222, #eee fallbacks in effect) | 3 (14px, 18px 18px 0 0, 2px) |
| mangonese.css (shared) | 0 | 0 | 1 (dark --text-muted fails contrast) | 0 |
