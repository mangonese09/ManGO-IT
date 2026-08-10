# Settings tab deep dive — 2026-08-10 (v1.4.0 live)

Measured walkthrough of the Settings tab (dark + light, both sheets, the
confirm modal, both toasts, DOM-measured layout), compared against the
settings surfaces of Google Maps (Material 3), Apple Maps / iOS grouped
lists, Citymapper, Transit and Waze. Findings ranked S-1..S-7; nothing
implemented — awaiting picks.

## What the benchmarks do

- **Apple / iOS grouped lists:** large page title; inset grouped cards with
  small uppercase section headers and footnote text under a group; rows are
  label left + muted current-value right + chevron; switches for booleans;
  destructive rows in red, isolated in their own group; the WHOLE row is the
  tap target, always.
- **Google Maps / Material:** full-width rows, current value as a muted
  subtitle under the label, tap opens a radio choice dialog or sub-screen.
- **Citymapper / Transit / Waze:** same bones — grouped, whole-row taps,
  choosers that show every option; personality lives in copy, not layout.

The shared invariants: (1) you can see a setting's current value AND discover
its option space without changing it, (2) one interaction model everywhere,
(3) cache maintenance and user-data destruction are never one button.

## Findings

**S-1 · P1 — "Clear cached data" is a data-loss trap.** The button's handler
is `clearAllAppData()` (js/settings.js:43): it wipes saved stops, places,
recents and settings along with the API cache, then reloads. The label says
*cache*; every mainstream app treats "clear cache" as safe by definition and
keeps "erase my data" a separate, red, deliberately scary action. The confirm
("Clear all cached data and settings?") names neither the favourites nor the
places it deletes. Fix: split into **"Clear cached schedules"** (cache.* +
CacheStorage only — genuinely safe) and a red **"Erase all data"** whose modal
itemises what dies ("Removes 12 saved stops, 4 places, 6 recent searches —
this cannot be undone"), exactly the pattern the storage-durability design
already specifies for import. This is the one finding that costs a real user
their data.

**S-2 · P1 — Cycling value-buttons hide the option space.** Theme, Search
results and Map style are pill buttons that CHANGE the setting on tap. "Auto"
gives no hint that Dark and Light exist; discovering the options requires
disturbing the setting. No benchmark app does discovery-by-mutation. Fix:
row shows the current value as muted text + chevron; tapping the ROW opens a
small styled sheet with the options as radio rows (the day-chip `is-active`
pattern already in the app). While there: Theme gains a **System** option
(follow `prefers-color-scheme`) — the guideline already mandates detection,
and Light/Dark/System is the Google/Apple convention.

**S-3 · P2 — Three interaction models on seven rows.** Chevron rows are
whole-row tappable; value rows only respond on the ~90px pill; action rows
only on the small Check/Clear buttons. Benchmarks use one model: the row is
the control. S-2's fix converts the value rows; make Check-for-updates a
whole-row action too, and the ragged right edge (measured pill widths 65, 77,
90, 108px) disappears with the pills.

**S-4 · P2 — No grouping, flat hierarchy, uneven rhythm.** One card mixes
appearance, search behaviour, data provenance, maintenance and about; the
"Settings" h2 renders at 16px — the same size as the row labels. Row heights
alternate 68px (button rows) / 48px (link rows). Fix: three groups with the
small uppercase header style the app already uses for day-parts ("MORNING"):
**Appearance** (Theme, Map style), **Search** (Results span), **Data**
(Data & schedules, Check for updates, Clear cached schedules · Erase all
data), then About standalone. Uniform ~52px rows. (The 16px h2 is app-wide —
Saved shares it; if raised, raise it as a type-scale decision, not a Settings
one-off.)

**S-5 · P3 — Emoji glyphs off the icon system.** 🌙/☀️ in the Theme and Map
style buttons are the only emoji controls in an app that hand-draws mango
icons for everything else. Either plain text values or house-style glyphs.

**S-6 · P3 — About sheet typography.** The attribution paragraphs run dense
and links wrap mid-phrase ("map data © / OpenStreetMap contributors").
Restructure as one attribution per line. Add the missing trust line the app
has earned: "Everything stays on this device — no account, no tracking" —
a differentiator no benchmark app can print.

**S-7 · P3 — "Search results" is label-vague.** "Search results: Whole day"
doesn't say what changes. The S-2 chooser gives each option a one-line
description ("Whole day — every remaining departure today" / "Next
departures — the first six only") for free.

## What is already better than the benchmarks — keep

- **Data & schedules sheet**: named sources, live "verified through 17 Sept
  2026" horizon, honest fares statement. No mainstream app shows provenance
  at all.
- **Update flow**: visible version, real check, reload on `controllerchange`
  (not a blind timer), honest "Up to date (v1.4.0)" toast.
- **About honesty**: the strikes (*scioperi*) warning is genuinely useful and
  charmingly on-brand.
- **Scope discipline**: no notification/account/ads clutter — seven rows is
  the right size for this app.
- Light theme renders clean throughout (post v1.3.2).

## Suggested order if all are taken

S-1 (data-loss trap — do first, it's small) → S-2 + S-3 + S-7 (one chooser
mechanism covers all three) → S-4 (grouping) → S-5 → S-6.
