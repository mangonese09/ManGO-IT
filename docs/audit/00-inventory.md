# Phase 0 — Inventory (no opinions, facts only)

Snapshot: 2026-07-26, v0.5.3 live, feed 577 routes / 4,772 trips / 44 operators.
SAIS Trasporti v0.6.0 in flight (21-day OD sweep completing; ships gated on its
own verifier). Facts below verified against the working tree at this commit.

## 1. Screens and tap paths (cold start)

Four views on a bottom nav (`js/app.js` VIEWS = home / saved / map / settings).
No routing/URLs — views toggle `hidden`; left-edge swipe + Android back pop a
manual nav stack.

| Task | Path from cold start | Taps |
|---|---|---|
| A→B search | Home → From field → type → pick suggestion → To field → type → pick → **Find routes** | 7 interactions (2 typing) |
| A→B, destination-first | Home → To field → type → pick → (auto "My location" + auto-search) | 4 |
| Trip detail | …results → tap itinerary card (opens bottom sheet) | +1 |
| Nearby departures | Home (auto-loads below search, needs geolocation) | 0 |
| Pin a departure | Home board → ☆ on a row | 1 |
| Favorite a stop | Saved tab → search field → type → pick suggestion | 4 |
| Depart-at / arrive-by | Home → **Depart** toggle → datetime input | 2–3 |
| Live train status | via itinerary detail (Trenitalia legs get live badge); direct VT lookup only through board/saved rows | — |
| Check for updates | Settings → Check | 2 |

Time control: `Depart`/`Arrive` toggle + one `datetime-local` input (blank =
now). It is one control, not three screens, but datetime-local UX is the
browser's own picker.

## 2. Client network calls (`js/api.js`)

All same-origin `/api/*`; every GET degrades to last cached response with
`stale:true` + fetchedAt stamp (rendered as staleness chips). 20s client
timeout. localStorage response cache pruned at 48h.

| Call | Used by | Payload |
|---|---|---|
| `/api/geocode?text=` | Home From/To suggest, Saved stop search | ≤10 typed results (STOP / COACH_STOP / PLACE / ADDRESS + modes, town, province) |
| `/api/plan?fromPlace&toPlace[&time&arriveBy]` | Find routes | slimmed itineraries |
| `/api/stops?lat&lon&r` | Nearby board, Map list | ≤40 stops sorted by distance |
| `/api/stoptimes?stopId&n` | Board rows, Saved pins refresh, favorite stops | next n departures, realTime flags |
| `/api/direct?fromLat…` | Results fallback when plan fails/empty | single-leg coach runs from own feed |
| `/api/coach-board?lat&lon&r` | Favorite coach stops | next 8 departures from own feed |
| `/api/vt/live`, `/api/vt/departures`, `/api/vt/stations` | live train status | ViaggiaTreno slimmed |

## 3. Proxy endpoints (`server/proxy.js`, zero-dep Node, pm2 port 3041)

| Endpoint | Wraps | Cache TTL | Failure mode |
|---|---|---|---|
| `/api/health` | — | none | — |
| `/api/geocode` | Transitous v1 geocode + own coach-stops name match | 24 h | upstream error → client falls back to its stale cache |
| `/api/plan` | Transitous **v3** plan, `numItineraries=6`, **45 s** upstream timeout | 60 s | error/empty → client calls `/api/direct`, labeled degraded |
| `/api/stops` | Transitous v1 map/stops (bbox from radius) | 5 min | as above |
| `/api/stoptimes` | Transitous v1 stoptimes | 60 s | as above |
| `/api/direct` | own coach-trips.json (single leg, today+tomorrow) | none | pure local |
| `/api/coach-board` | own coach-trips.json (per-stop board) | none | pure local |
| `/api/vt/*` | ViaggiaTreno (HTTP only; 204 = "no live data") | 60 s / 24 h stations | 204 honored as no-data, not error |

Notable, verbatim from code: **`/api/plan` sends no maxTransfers, no walking
radius, no mode filters, no intermodal settings** — MOTIS defaults only.
Per-day upstream request counter in `/api/health` (Transitous policy). UA is
spec-compliant (name/version/URL/contact). In-memory cache Map, no size cap.
Rate limit: 90 req/min/IP on the proxy.

## 4. GTFS pipeline (Python, deterministic, no LLM)

Stages (pipeline/README.md, verified against code): Wayback CDX crawl →
`extract.py` (pdfplumber word boxes) → `grid_parse.py` (deterministic grids;
layout families A, A2 split-name, B) → `assemble.py` (+`tua_parse.py`) →
`geocode.py` (Nominatim, cache, overrides incl. `interpolate:true`,
km-interpolation) → `sais_harvest.py` (Albatross API, exact validities) →
`saist_harvest.py` (booking-API OD stitching, 21-day sweep, swept-dates-
authoritative calendars) → `emit_gtfs.py` → `validate.py` (ship gate) →
`export_stops.py` (server indexes) → `sais_verify.py` / `saist_verify.py`
(live cross-checks) → `blame_quarantine.py` / `recover_geocodes.py` (repair).

Emits: calendar_dates-only GTFS, window 2026-08-01→2027-07-31; **real data
horizons end ~2026-09-14** (TPL summer period) — refreshed weekly (Autolinee,
Task Scheduler job) / re-harvest for the rest.

Gates that block shipping (validate.py): referential integrity, monotonic
times, Sicily bbox, ≥2 stops/trip, implied speed >110 km/h, slow-floor
<5 km/h at street precision, calendar assertions pinned to Ferragosto/
Pasquetta/Saturday/school-breaks, service-label decode, prescription topology
assertions (divieto). Emit-time quarantine: ~1,100 trips currently held
(fused-name parse residue on smaller PDF operators; blame tooling exists).

## 5. Test suite

23 node:test unit/fixture tests (`npm test`): direct-fallback fixtures
(Siracusa festivo Sunday, weekday≥Sunday invariant, Ferragosto semantics,
explicit-date services, coach-board), ViaggiaTreno parsers, Rome-time
helpers, version-sync (package/version.json/js/version.js, ?v= busting, SW
precache list). Pipeline gates run per build, not in npm test.

**Not covered:** any real-browser/session test in this repo (no Playwright;
`tests/sessions/` exists only in ManGO classic), the client render layer,
the SW lifecycle (the v0.5.3 stale-precache bug shipped through the suite),
proxy endpoints end-to-end (only pure functions are imported), geocode
ranking, plan-response slimming.

## 6. Capacitor / Android

**Absent from the repo.** No `android/`, no capacitor config. M7 in the PRD
is planned, not started. PWA installs via manifest; back button/edge-swipe
handled in JS; no widget.

## 7. Open questions (not guessed)

1. Transitous PR #2327 merge timing — external; determines when `/api/plan`
   sees coaches at all. (Owner action: Matrix intro post.)
2. Italian VPS purchase (~€1–5/mo) — unblocks live portal PDFs + any
   IP-restricted sources; decision pending owner.
3. MOTIS local instance for the with-feed audit baseline: run real MOTIS
   (docker, needs OSM extract) vs. a small deterministic CSA router over our
   own zip for matrix purposes. Cost/fidelity call to make at Phase 1A start.
4. Ferry sources (Liberty Lines etc.): no recon done yet — Phase 3.
5. `/api/plan` slimming: does `slimItinerary` drop fields the redesign needs
   (fares, polylines, alerts)? To check against Phase 4 designs.
