# Transit Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One tap on an airport/main-station "hub" pin shows a unified, time-sorted departures board across trains + coaches + urban buses at that hub.

**Architecture:** A curated hub table + pure `mergeDepartures()` in `server/proxy.js`; a new `GET /api/hub-board` that fans out to the three existing sources (ViaggiaTreno rail, `coachBoard`, Transitous `/api/stoptimes`) and merges them; hub-pin emission in `/api/map-stops`; a client `openHubBoard()` sheet reusing the board renderer. Spec: `docs/2026-07-31-transit-hub-feature-spec.md`.

**Tech Stack:** Node (proxy.js, no deps, route object `'GET /api/x': async (q) => {}`), ES-module client (`js/*.js`), `node --test` runner, pm2 on the VPS.

## Global Constraints

- No new dependencies; match existing style (proxy = plain async funcs + `upstream()`/`cacheGet`/`cacheSet`/`haversineM`/`httpError`; client = ES modules).
- Pure/testable logic goes in `server/proxy.js` and is exported in its `module.exports` for `tests/unit/proxy-helpers.test.js` (`node --test`).
- Reuse, don't reinvent: rail board = the existing ViaggiaTreno path (same call `/api/…` VT board uses via `resolveVtCode`); coaches = `coachBoard(lat,lon,r,all)`; urban = `/api/stoptimes` logic (Transitous stoptimes). Proximity = `haversineM`.
- Row shape (the common departure): `{ mode:'RAIL'|'COACH'|'BUS', line, headsign, timeISO, minutes, operator, stopName, realtime, stopId }`.
- Deploy bumps `version.json` + `js/version.js` + `package.json` + `service-worker.js` (`CACHE` + `?v=`) together (version-sync + sw tests enforce it). Current: **0.28.3**.
- Work on a branch; commit after each task.

---

### Task 1: Curated hub table + `hubsInBbox()`

**Files:**
- Modify: `server/proxy.js` (add `HUBS` const + `hubsInBbox()` near `clusterStopsByProximity`; export both)
- Test: `tests/unit/proxy-helpers.test.js`

**Interfaces:**
- Produces: `HUBS` (array of `{id,name,kind:'airport'|'rail',lat,lon,radiusM,railName?}`); `hubsInBbox(minLat,minLon,maxLat,maxLon) -> HUBS subset inside the box`.

- [ ] **Step 1: Write the failing test**
```js
test('hubsInBbox returns only hubs inside the viewport', () => {
  const box = [38.09, 13.34, 38.13, 13.39]; // central Palermo
  const ids = hubsInBbox(...box).map((h) => h.id);
  assert.ok(ids.includes('palermo-centrale'), 'Palermo Centrale is in-box');
  assert.ok(!ids.includes('catania-centrale'), 'Catania is not in this box');
  assert.ok(HUBS.every((h) => h.lat && h.lon && h.name && h.kind), 'every hub is well-formed');
});
```

- [ ] **Step 2: Run it, verify it fails**
Run: `node --test tests/unit/proxy-helpers.test.js` → FAIL `hubsInBbox is not defined`.

- [ ] **Step 3: Implement**
Add to `server/proxy.js` (coords are approximate — fine for a ~400m hub radius):
```js
const HUBS = [
  { id: 'palermo-airport', name: 'Aeroporto Falcone Borsellino', kind: 'airport', lat: 38.1815, lon: 13.0995, radiusM: 500 },
  { id: 'catania-airport', name: 'Aeroporto Catania Fontanarossa', kind: 'airport', lat: 37.4668, lon: 15.0664, radiusM: 500 },
  { id: 'trapani-airport', name: 'Aeroporto Trapani-Birgi', kind: 'airport', lat: 37.9114, lon: 12.4880, radiusM: 500 },
  { id: 'comiso-airport', name: 'Aeroporto di Comiso', kind: 'airport', lat: 36.9946, lon: 14.6072, radiusM: 500 },
  { id: 'palermo-centrale', name: 'Palermo Centrale', kind: 'rail', lat: 38.1103, lon: 13.3680, radiusM: 400, railName: 'PALERMO CENTRALE' },
  { id: 'catania-centrale', name: 'Catania Centrale', kind: 'rail', lat: 37.5100, lon: 15.0980, radiusM: 400, railName: 'CATANIA CENTRALE' },
  { id: 'messina-centrale', name: 'Messina Centrale', kind: 'rail', lat: 38.1780, lon: 15.5530, radiusM: 400, railName: 'MESSINA CENTRALE' },
  { id: 'siracusa', name: 'Siracusa', kind: 'rail', lat: 37.0680, lon: 15.2790, radiusM: 400, railName: 'SIRACUSA' },
  { id: 'ragusa', name: 'Ragusa', kind: 'rail', lat: 36.9250, lon: 14.7290, radiusM: 400, railName: 'RAGUSA' },
  { id: 'agrigento-centrale', name: 'Agrigento Centrale', kind: 'rail', lat: 37.3110, lon: 13.5770, radiusM: 400, railName: 'AGRIGENTO CENTRALE' },
  { id: 'caltanissetta-centrale', name: 'Caltanissetta Centrale', kind: 'rail', lat: 37.4880, lon: 14.0630, radiusM: 400, railName: 'CALTANISSETTA CENTRALE' },
  { id: 'enna', name: 'Enna', kind: 'rail', lat: 37.5620, lon: 14.2880, radiusM: 400, railName: 'ENNA' },
  { id: 'trapani', name: 'Trapani', kind: 'rail', lat: 38.0170, lon: 12.5370, radiusM: 400, railName: 'TRAPANI' },
];
function hubsInBbox(minLat, minLon, maxLat, maxLon) {
  return HUBS.filter((h) => h.lat >= minLat && h.lat <= maxLat && h.lon >= minLon && h.lon <= maxLon);
}
```
Add `HUBS` and `hubsInBbox` to `module.exports`.

- [ ] **Step 4: Run tests → PASS**
- [ ] **Step 5: Commit** `git commit -am "feat(hub): curated hub table + hubsInBbox"`

---

### Task 2: `mergeDepartures()` — normalize + time-sort + cap

**Files:**
- Modify: `server/proxy.js`
- Test: `tests/unit/proxy-helpers.test.js`

**Interfaces:**
- Produces: `mergeDepartures(lists, nowMs, opts) -> departures[]` — `lists` is an array of already-shaped row arrays; drops rows with `timeISO` in the past, sorts ascending by `timeISO`, computes `minutes = round((t-now)/60000)`, applies `opts.perMode` cap per mode then `opts.cap` overall (defaults: perMode 8, cap 30).

- [ ] **Step 1: Failing test**
```js
test('mergeDepartures merges, drops past, sorts, caps per mode', () => {
  const now = Date.parse('2026-08-01T08:00:00Z');
  const rail = [{ mode:'RAIL', line:'R1', headsign:'X', timeISO:'2026-08-01T08:10:00Z' }];
  const coach = [{ mode:'COACH', line:'224', headsign:'Pomara', timeISO:'2026-08-01T07:50:00Z' }, // past → dropped
                 { mode:'COACH', line:'224', headsign:'Pomara', timeISO:'2026-08-01T08:05:00Z' }];
  const out = mergeDepartures([rail, coach], now, { cap: 10, perMode: 8 });
  assert.strictEqual(out.length, 2, 'past row dropped');
  assert.strictEqual(out[0].line, '224', 'earliest first (08:05 before 08:10)');
  assert.strictEqual(out[0].minutes, 5, 'minutes computed from now');
  assert.ok(out.every((r) => r.mode && r.timeISO), 'rows keep shape');
});
```

- [ ] **Step 2: Verify fail** (`mergeDepartures is not defined`)

- [ ] **Step 3: Implement**
```js
function mergeDepartures(lists, nowMs, opts = {}) {
  const perMode = opts.perMode || 8, cap = opts.cap || 30;
  let rows = [].concat(...(lists || [])).filter((r) => r && r.timeISO && Date.parse(r.timeISO) >= nowMs);
  rows.sort((a, b) => Date.parse(a.timeISO) - Date.parse(b.timeISO));
  const seen = {};
  rows = rows.filter((r) => { seen[r.mode] = (seen[r.mode] || 0) + 1; return seen[r.mode] <= perMode; });
  rows = rows.slice(0, cap);
  return rows.map((r) => ({ ...r, minutes: Math.round((Date.parse(r.timeISO) - nowMs) / 60000) }));
}
```
Export `mergeDepartures`.

- [ ] **Step 4: PASS**  — [ ] **Step 5: Commit** `feat(hub): mergeDepartures (normalize + sort + cap)`

---

### Task 3: `GET /api/hub-board` endpoint (fan-out)

**Files:**
- Modify: `server/proxy.js` (add the route to the routes object; add 3 small normalizers)
- Manual verify (integration — no unit test; the pure parts are Tasks 1–2)

**Interfaces:**
- Consumes: `HUBS`, `mergeDepartures`, `coachBoard`, `/api/stoptimes` logic, the VT board path.
- Produces: `GET /api/hub-board?hubId=…` → `{ hub:{id,name,kind}, asOf, departures:[…] }`.

- [ ] **Step 1: Add the route** (mirror existing route style; wrap each source in `try/catch → []` so one dead source never blanks the board)
```js
'GET /api/hub-board': async (q) => {
  const hub = HUBS.find((h) => h.id === q.get('hubId'));
  if (!hub) throw httpError(404, 'unknown hub');
  const now = Date.now();
  const [rail, coach, urban] = await Promise.all([
    hub.kind === 'rail' ? railRows(hub).catch(() => []) : Promise.resolve([]),
    coachRows(hub).catch(() => []),
    urbanRows(hub).catch(() => []),
  ]);
  const departures = mergeDepartures([rail, coach, urban], now, { perMode: 10, cap: 40 });
  return { hub: { id: hub.id, name: hub.name, kind: hub.kind }, asOf: now, departures };
},
```

- [ ] **Step 2: Add the three normalizers** (reuse existing fetchers; each returns the common row shape)
```js
// COACH: our own feed board around the hub.
async function coachRows(hub) {
  const { results = [] } = await coachBoardData(hub.lat, hub.lon, hub.radiusM, true); // same producer /api/coach-board uses
  return results.map((r) => ({ mode: 'COACH', line: r.route, headsign: r.headsign,
    timeISO: r.depISO || isoFromRomeHHMM(r.dep), operator: r.operator || null, stopName: r.stopName || hub.name, realtime: false, stopId: null }));
}
// URBAN + any rail Transitous also returns: Transitous stoptimes for the hub's transit stop(s) in radius.
async function urbanRows(hub) {
  const stops = await stopsInRadius(hub.lat, hub.lon, hub.radiusM); // reuse /api/map-stops transit fetch
  const lists = await Promise.all(stops.map((s) => stoptimesData(s.stopId, 12).then((d) => (d.stopTimes || []).map((st) => ({
    mode: st.mode === 'RAIL' ? 'RAIL' : 'BUS', line: st.routeShortName || st.displayName || '', headsign: st.headsign || '',
    timeISO: st.departure || st.scheduledDeparture, operator: st.agencyName || null, stopName: st.place?.name || s.name, realtime: !!st.realTime, stopId: s.stopId,
  }))).catch(() => [])));
  return [].concat(...lists);
}
// RAIL: live ViaggiaTreno board for the station (only for rail hubs).
async function railRows(hub) {
  const board = await vtBoardData(hub.railName); // same producer the VT board endpoint uses (resolveVtCode + partenze)
  return (board?.departures || []).map((d) => ({ mode: 'RAIL', line: d.number || d.category || 'Treno', headsign: d.destination,
    timeISO: d.departureISO, operator: 'Trenitalia', stopName: hub.name, realtime: true, stopId: null }));
}
```
> Implementer note: `coachBoardData`, `stoptimesData`, `vtBoardData`, `stopsInRadius` are the internal producers the existing `/api/coach-board`, `/api/stoptimes`, VT board, and `/api/map-stops` routes already call — extract/reuse them rather than re-fetching. If a route currently inlines its fetch, refactor the fetch body into a named helper and have both the route and this task call it (DRY). `isoFromRomeHHMM` converts a coach "HH:MM" today-string to an ISO instant in Europe/Rome (mirror how `coachBoard`/`romeParts` already handle the day).

- [ ] **Step 3: Verify locally/live**
`curl 'https://it.mangonese.dev/api/hub-board?hubId=palermo-centrale'` → JSON with `departures` mixing RAIL + BUS/COACH, time-sorted, `minutes` present, none in the past.

- [ ] **Step 4: Commit** `feat(hub): /api/hub-board fan-out endpoint`

---

### Task 4: Hub pins on the map (`/api/map-stops` + `js/mapview.js`)

**Files:**
- Modify: `server/proxy.js` (`GET /api/map-stops`: after building `transit`, emit hub features + absorb their nearby stops)
- Modify: `js/mapview.js` (render a hub pin; tap → `openHubBoard`)

- [ ] **Step 1 (server):** In `/api/map-stops`, compute the viewport bbox (already derived for the Transitous call), then:
```js
const hubs = hubsInBbox(lat - dLat, lon - dLon, lat + dLat, lon + dLon);
// drop transit/coach stops that fall inside a hub radius (absorbed under the hub pin)
const absorbed = (s) => hubs.some((h) => haversineM(h.lat, h.lon, s.lat, s.lon) <= h.radiusM);
transit = transit.filter((s) => !absorbed(s));
const hubFeatures = hubs.map((h) => ({ kind: 'hub', hubId: h.id, subkind: h.kind, name: h.name, lat: h.lat, lon: h.lon }));
```
Include `hubFeatures` in the response (alongside the existing transit/coach arrays, however the route currently returns them).

- [ ] **Step 2 (client):** In `js/mapview.js`, where pins are built from `/api/map-stops`, add a branch for `kind === 'hub'`: draw a distinct pin (airport ✈ / rail 🚉 glyph via `modeIcon`/an emoji marker) and `onclick: () => openHubBoard(feature)`.

- [ ] **Step 3: Verify** Load the map near Palermo Centrale / an airport → a single hub pin appears (constituent stop pins absorbed), distinct from bus pins.

- [ ] **Step 4: Commit** `feat(hub): hub pins on the map + stop absorption`

---

### Task 5: `openHubBoard()` client sheet

**Files:**
- Modify: `js/mapview.js` or `js/saved.js` (add `openHubBoard`; reuse the sheet + row rendering from `openStopSchedule`)
- Modify: `js/api.js` (add `hubBoard: (hubId) => getJson('/api/hub-board?hubId=' + encodeURIComponent(hubId), {...})`)

- [ ] **Step 1:** Add the api fetcher `hubBoard`.
- [ ] **Step 2:** `openHubBoard(hub)` opens a sheet titled `hub.name`, fetches `api.hubBoard(hub.hubId)`, and renders `departures` with the SAME row element used in `openStopSchedule` (time + mode icon + `line → headsign` + `live` badge + "in N min"). Add a mode-filter chip row (All / Trains / Buses) reusing the existing chip pattern; filtering hides rows by `mode` (RAIL vs COACH/BUS). Make it favoritable via `favKey`/`isFavStop` like stops.
- [ ] **Step 3: Verify** Tap a hub pin → combined board, chips filter, rows tappable, live trains badged.
- [ ] **Step 4: Commit** `feat(hub): openHubBoard combined departures sheet`

---

### Task 6: Ship

**Files:** `version.json`, `js/version.js`, `package.json`, `service-worker.js`, `index.html`

- [ ] **Step 1:** Bump to **0.29.0** everywhere (client 4 files + `?v=`), bump `service-worker.js` `CACHE` (`mangoit-v66`), and set proxy `UA`/`/api/health` version to `0.29.0`.
- [ ] **Step 2:** `npm test` → all green (incl. version-sync + the new hub tests).
- [ ] **Step 3: Deploy:** `scp server/proxy.js → /opt/mangoit/`; static (`index.html service-worker.js version.json` → `/var/www/mangoit/`, `js/*.js` → `/var/www/mangoit/js/`, `css/styles.css` → `/var/www/mangoit/css/`); `ssh … pm2 restart mangoit-proxy`; verify `/api/health` = 0.29.0 and `curl …/api/hub-board?hubId=palermo-centrale`.
- [ ] **Step 4: Commit + merge** to `main`, push.

---

## Self-Review

**Spec coverage:** curated hub set → T1; unified merged board (`/api/hub-board` fan-out to rail/coach/urban + merge-sort + per-mode cap) → T2+T3; hub pin + absorption → T4; hub sheet with mode filter + favorites → T5; tests → T1/T2 (pure), manual for integration; rollout → T6. Open spec questions (horizon/cap, island airports, per-mode caps) are resolved: `perMode:10, cap:40`, airports limited to the 4 mainland-served fields, per-mode cap in `mergeDepartures`.

**Placeholder scan:** the only non-literal references (`coachBoardData`, `stoptimesData`, `vtBoardData`, `stopsInRadius`, `isoFromRomeHHMM`) are called out as *extract-from-existing-route* with explicit instruction — not invented APIs. The implementer confirms each against the current route bodies before use.

**Type consistency:** the common row shape `{mode,line,headsign,timeISO,minutes,operator,stopName,realtime,stopId}` is produced by all three normalizers (T3), consumed by `mergeDepartures` (T2) and the sheet (T5). `hubId`/`kind`/`name`/`lat`/`lon`/`radiusM` consistent across T1/T3/T4.

**Risk to confirm during T3:** the exact producers behind VT board + coach board + stoptimes — extract them into named helpers so the endpoint and the routes share one implementation (DRY), rather than duplicating fetch logic.
