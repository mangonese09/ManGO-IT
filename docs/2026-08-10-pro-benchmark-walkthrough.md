# Pro-benchmark walkthrough — 2026-08-10 (v1.3.1/v1.3.2 live)

**STATUS: ALL FINDINGS SHIPPED in v1.4.0 (2026-08-10, commit 5ce59c8)** — the
user chose "do them all in that order". F-1 had shipped in v1.3.2. Verified:
154/154 unit, 13-check measured Playwright pass local AND live, session-core
16/16, session-airport all pass, F-6 measured (14 query tops unchanged,
Rosselli punctuation variants collapse). Findings below kept for the record.

Full-app tour at 390 px against the live site (dark + light themes), 22
screenshots, zero console/page errors across every screen. Each surface
compared to Google Maps, Apple Maps, Waze, and the commuter apps (Citymapper,
Transit). Findings are ranked; nothing below is implemented except F-1
(shipped as v1.3.2 during the walkthrough because it was an unambiguous
contrast bug, not a design call).

Waze note: Waze is driving-only navigation — its relevant lessons here are
"one job per screen" and aggressive de-clutter, both cited under F-4.

## Verdicts by surface

| Surface | vs benchmark | Notes |
|---|---|---|
| Home search card | **At parity** | Post-v1.3.0: symmetric fields, quick-picks (place shortcuts + recents) = Google's field-focus pattern; mode toggles/chips one convention |
| Suggestions | **At parity+** | Type labels ("train & bus station", "landmark") are something Google does NOT do — keep; F-6 dedupe nit |
| Results list | **At parity** | Filter chips w/ counts, Earlier-departures paging, day-part headers, honest status chips; F-5 duplication, F-9 fares |
| Trip detail | **At parity** | Per-stop times, operator, live-data honesty, ticketing with "leaves ManGO:IT", replacement-bus explainer; F-7 map link missing |
| Stop board (rail) | **Above parity** | Today/Tomorrow/date chips, platform (Bin.) numbers, live source attribution — Google's station view shows less |
| Hub board | **At parity** | Mode chips + lens search + star; F-2 grouping, F-3 bare rows |
| Map | **Mixed** | Distinct pin families, own labels, hub pins all good; F-4 density at city zoom is the one real gap vs Google/Apple |
| Saved | **At parity** | Clean empty states (explain + invite); F-2/F-3/F-8 apply to its boards |
| Settings | **At parity** | Provenance sheets, version + update check, map style |

## Findings (ranked)

**F-1 · P1 · FIXED (v1.3.2)** — Light-theme timezone banner was invisible:
`.tz-banner` used `var(--text, …)` but `--text` is not a defined token, so it
silently fell back to near-white on the peach banner. Now `--text-primary` +
explicit light override; verified live `rgb(74,50,0)`.

**F-2 · P1 — Group departures by line + headsign.** Every board (hub, stop
sheet coach side, Saved cards) renders one row per departure: "N4 → Sarullo
04:24" and "N4 → Sarullo 04:25" as neighbouring rows. Google/Transit/
Citymapper group: one row per line+destination with the next 2-3 times
stacked ("N4 → Sarullo · 04:24, 04:55, 05:25"). Halves the row count on busy
boards and is the single highest-value change on the list. (The VT rail board
is naturally one-per-train and is fine as is.)

**F-3 · P1 — No board row may read bare "BUS".** Trenitalia rail-replacement
runs with empty headsigns render as "BUS — 6 min" with no line or
destination. The VT enrichment covers rail rows; these BUS-mode rows escaped
it. Pro apps never show a nameless departure. Fix: enrich via VT like the
rail rows, or at minimum label them "Rail replacement bus" with the train
number they replace.

**F-4 · P2 — Pin density at city zoom.** At Palermo-wide zoom the map is a
carpet of ~30 px illustrated discs (see `qa/…21-light-map` shot). Google/
Apple/Waze render minor stops as small dots (or nothing) and reserve full
markers for interchanges, favourites, and hubs; markers grow as you zoom.
Suggest: below a threshold zoom, minor stops render as 10-12 px dots keeping
the family colour; clusters/hubs/favourites keep the disc treatment.

**F-5 · P2 — Timezone stated twice on one screen.** With results open, the
card footnote ("All times are Italy time — 7 hours ahead…") AND the results
banner ("Italy time — 7 hours ahead of your phone") are both visible. Say it
once: keep the results banner (it sits next to the times it explains), drop
the card footnote to its pre-gap "Blank = leave now" form when results exist
— or hide the footnote whenever the banner is rendered.

**F-6 · P2 — Near-duplicate coach-stop suggestions.** "Agrigento (P.le
Rosselli)" and "Agrigento P.Rosselli" surface as two rows — same stop,
different punctuation, so the `name|town` dedupe misses it. Normalise
punctuation/abbreviations (P.le/Piazzale, parentheses, hyphens) in the dedupe
key only — display names stay as-is.

**F-7 · P2 — Trip detail has no "view on map".** The app already traces
routes on the Map tab, but a trip sheet never offers it. Google/Apple always
pair an itinerary with its map. A "Show on map" row in the trip sheet that
jumps to the existing trace closes the gap with code that already exists.

**F-8 · P2 — Saved-stop subtitle undersells multi-modal stations.** Saved
card says "train station" for Palermo Centrale while listing its buses below.
Reuse the v1.3.0 compound kind ("train, tram & bus station") — same class of
fix as backlog item 7, one label site that was missed.

**F-9 · P3 — Exact fares could ride the itinerary card.** City-bus flat fares
(AMAT €1.40 etc.) are exact in the data but only appear in trip detail.
Google/Citymapper show a fare chip on the card when known. Honest-states rule
stands: exact fares only, never estimates.

**F-10 · P3 — Name cosmetics.** "Cefalu'" (trailing apostrophe instead of
"Cefalù"), "Taormina- C Ainis" (spacing) — the known ~25 ugly-but-correct
names class from the recovery cycles, now visible in polished surfaces.

**F-11 · P3 — Quick-picks ordering.** "Choose on map" leads the list; Google
orders saved/recents first with map-pick lower. Arguable (ours is an input
method, not a destination) — flag only, decide with taste.

## What is deliberately better than the benchmarks — do not "fix"

- Suggestion type labels ("train & bus station", "coach stop", "landmark").
- Honesty surfaces: "No live data for this train yet", "leaves ManGO:IT",
  replacement-bus explainer, source attribution on boards, dimmed
  already-departed runs.
- Whole-day results with day-part headers + Earlier/Later paging.
- Platform (Bin.) numbers on the live rail board.

## Suggested order if all are taken

F-2 → F-3 (same board-rendering code, one pass) → F-5 + F-8 (trivial) →
F-6 → F-7 → F-4 (the only one needing design care) → F-9 → F-10 → F-11.
