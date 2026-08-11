# Map tab deep dive — 2026-08-10 (v1.9.0 live)

**STATUS: ALL TEN FINDINGS SHIPPED in v1.10.0 (2026-08-10, user: "Do these
all").** Verified: 167/167 unit (incl. new outOfCoverage tests), 25-check
measured Playwright harness (scratch verify-map.js) local AND live,
session-update.js 5 sessions (SW precache changed), session-core 16/16 on
prod. Server got `outOfCoverage` (Malta bbox filter in transitStopsInRadius);
the itinerary info bar walks past MOTIS's "START"/"END" junk endpoint names
and reuses romeTime. Findings below kept for the record.

Method: full read of `js/mapview.js` (1,271 lines) + `js/city-labels.js`, then a
measured Playwright tour of the LIVE site at 390×844 — 20 screenshots across
dark + light themes, two profiles (no-geolocation island first-open, and a
granted-fix Palermo street open), zero page errors. Every state measured
(getBoundingClientRect + computed styles) and compared to Google Maps, Apple
Maps, Citymapper and Transit. This is the follow-up the 2026-08-10
pro-benchmark walkthrough deferred: Map was its only "Mixed" surface, and it
has since gained double-tap-drag zoom, heat-blob filtering, and the chip
toolbar without a dedicated review.

States toured: island first-open (blobs/hubs/own city labels/hint), filter
chips incl. the last-chip guard toast, grouped hub pin → "Transit hubs here"
picker, mid zoom (99 blobs, labels), dot zoom (z13–14), street zoom + the
nearest-stop chip, map search (empty + results + pick), coach routes sheet →
road-snapped trace → info bar → line stop-list sheet, light theme (voyager
tiles), you-dot street open with fix, locate button return, choose-on-map pick
mode (lift verified mid-drag), trip-sheet "Show on map" itinerary trace.
Double-tap-drag zoom was not re-exercised (synthetic-touch verified at v0.34.0;
unchanged since).

## Verdict

**At parity or better on interaction mechanics; the gaps are coverage honesty
(two P1s found at the edges of the service area) and location affordances.**
The F-4 dot/disc split, own city labels, in-place filter toggles, and the
choose-on-map kinesthetics all hold up against the benchmarks. Nothing here is
structural — the biggest fix is a few lines of clamping.

## Findings (ranked)

**M-1 · P1 — No service-area clamp: the map zooms and pans to the whole
Mediterranean.** Nine taps of − from the island view landed on a world view
where Sicily is a speck between a blank France and a blank Libya (screenshot
`assets/map-deep-dive/zoomed-out-mediterranean.png`) — every mainstream app
clamps to its coverage (Transit/Citymapper hard-bound their regions; Google
has global content so its min zoom is moot for us). We fit `SICILY_BOUNDS` on
open but set no `minZoom`/`maxBounds`, so a stray pinch strands the user in
empty world. Fix: `minZoom` ≈ 7 + `map.setMaxBounds` on a padded Sicily box.
CARE: itinerary traces can legitimately leave the box (VT rail + hub-stitch
reach the mainland; strait-side Calabria is in-coverage) — pad the bounds to
include the strait/southern Calabria, and lift/re-apply the clamp around
`showItineraryOnMap`'s `flyToBounds` so a mainland trace never fights it.

**M-2 · P1 — An out-of-coverage stop renders on Malta.** The island view shows
a lone bus pin in open sea south of Ragusa; probing the live API
(`/api/map-stops` centred on Malta) returns exactly one stop: **"Aeroporto di
Malta (MLA)"** — Transitous serves Malta, and `transitStopsInRadius` has no
service-boundary filter, so the island-zoom 200 km radius sweeps it in. It
reads as a data error at first sight, and tapping it opens a board for a stop
the app doesn't serve. Fix server-side: bbox-filter transit stops to the
coverage box (Malta sits at lat 35.86 — a south cut ≈ 36.4 removes it while
keeping Lampedusa/Linosa is NOT true: Lampedusa is 35.5 — so filter by the
explicit coverage bbox used elsewhere, or exclude the Malta bbox
specifically; decide against real Pelagie-island data before shipping).

**M-3 · P2 — The locate button wears the place-pin glyph.** `.map-locate-btn`
renders `/icons/place-pin.png` — the universal convention for "centre on me"
is a crosshair/target (Google, Apple, Waze, every Leaflet/Mapbox app), while
a place-pin means "a dropped location". The SAME pin artwork is also the
actual choose-on-map pick pin and the POI marker, so one glyph carries three
meanings; the button reads "drop a pin here", not "find me". Fix: a
mango-house-style crosshair SVG (40×40, gradient disc family).

**M-4 · P2 — The you-dot is a bare 16 px circle: no accuracy halo, no
heading, no follow.** Google/Apple/Transit show an accuracy circle (and a
heading cone when the device reports one) and keep the dot moving via
`watchPosition` while the map is open; ours is a one-shot snapshot that only
moves when the locate button is tapped. Minimum: draw the accuracy radius
from the fix we already have. Optional second step: `watchPosition` while the
Map tab is visible (battery-cheap, stops on tab switch).

**M-5 · P2 — The itinerary trace has no chrome — no summary, no ✕, no way
back.** "Show on map" from a trip sheet draws the trace and nothing else;
returning to the trip means knowing that a background tap clears the
highlight (undiscoverable) or using the bottom nav. The zoom hint pill
("Zoom in to see stops") even keeps rendering over an active trace. A COACH
route trace gets the full info bar (name/swatch/Stops/★/✕) — itinerary
traces should reuse it: origin → destination title, ✕ to clear, and ideally
"Back to trip" reopening the sheet. Suppress the hint pill while any
highlight is active.

**M-6 · P2 — Touch targets under the app's own 44 px floor throughout the
map chrome.** Measured: filter chips 32 px tall, Leaflet zoom buttons
30×30, info-bar buttons 34×34, pick-mode cancel 28×28 (CLAUDE.md floor:
44×44 with 8 px gaps; Google's 32 dp-visual chips carry ≥48 dp hit areas via
padding). Keep the visual sizes — expand the HIT areas (transparent padding +
negative margin, the same trick About links use). The 44×44 locate button is
already compliant.

**M-7 · P3 — Map search opens onto a blank sheet.** Home's field-focus shows
saved places + recent destinations (v1.3.0's quick-picks); the map's "Find a
place" sheet shows nothing until two characters are typed. Google's map
search leads with recents; ours has the machinery (`pickQuick`, saved
places, recents store) — reuse it minus the "My location"/"Choose on map"
rows, tapping a row recentring the map.

**M-8 · P3 — Info-bar route name truncates early.** "Raffadali – Favara"
renders as "Raffadali –…" — the title shares one row with ‹/Stops/★/✕, so
~10 characters survive on 390 px. Same class as v1.6.0's leg-strip 12ch cap
(F-3 of the field report). Let the name wrap to two lines, or drop the ‹
back button when only one route exists (it already only renders for
multi-route stops — drop it when `routes.length === 1` is already handled;
the win is the wrap).

**M-9 · P3 — Town rows still use the 🏘️ emoji icon.** Map search (and Home
suggest — shared classifier) render towns with an emoji while every other
kind has a mango-family icon; S-5 (settings round) removed the app's other
emoji. Needs a small mango-style town SVG in the place-icon set.

**M-10 · P3 — Pick-mode pins stay full-opacity while inert.** During
choose-on-map the stop pins are correctly non-interactive but look fully
live; Google dims non-relevant layers in pick contexts. One CSS rule
(`.picking .stop-pin/.stop-dot { opacity: .45 }`) makes the mode legible.

## What measured at or above benchmark — do not "fix"

- **Nearest-stop chip** ("Nearest stop: Guastaferro · 410 m →") when a street
  viewport holds no pins — none of the four benchmarks has this; it kills the
  "map is broken" dead-end.
- Own city labels below z13: denser than Carto raster, zoom-stable, offset
  around hub discs, never buried under pins.
- In-place filter chips: 0 network calls, no blank flash, heat blobs restamp
  per family; last-chip guard toast is honest.
- Hub layer: always-on, pixel-measured grouping into a picker at island zoom,
  name pills at z≥11.
- Coach route traces: road-snapped line + tappable casing + every-stop dots +
  line stop-list sheet — the coach differentiator Google cannot match.
- Choose-on-map kinesthetics: centre pin lifts on drag (verified mid-gesture),
  ground dot marks the exact point, live reverse-geocoded address.
- One-finger double-tap-drag zoom (Google gesture), zoom-aware hint that
  retires after first success, 44×44 locate button, honest offline fallback
  list.

## Accepted limitations (state, don't fight)

- No rotation/tilt and no tappable basemap POIs — raster-tile Leaflet
  constraints; the benchmarks' vector stacks aren't worth the migration for
  this app.
- No live vehicle dots — no domestic GTFS-RT exists (researched
  `docs/gtfs-rt-research.md`).
- Zoom +/− buttons stay (Google mobile drops them, but they serve desktop and
  cost nothing top-right).

## Suggested order if all are taken

M-1 + M-2 (coverage honesty, one clamp + one bbox filter) → M-3 + M-4 (one
location-affordance pass) → M-5 → M-6 → M-7 → M-8 → M-9 → M-10.

Tour screenshots: `docs/assets/map-deep-dive/` (island dark, street with fix,
trace + info bar, chrome-less itinerary trace, Mediterranean zoom-out).
Measurements JSON archived with the session scratchpad harness (map-tour.js).
