# Transit Hub feature — design spec

- **Date:** 2026-07-31
- **Status:** Approved direction (from chat); ready for implementation planning
- **App:** ManGO:IT (Sicily intercity transit PWA)

## Goal

Let a traveler at a major transport hub — an airport or a main rail station — tap
**one pin** and see **everything leaving from here across every mode** (trains +
intercity coaches + urban buses) in a single time-sorted departures board, instead
of hunting individual stop pins.

## Decisions (from discussion)

| Question | Decision |
|---|---|
| How is a "hub" identified? | **Curated list**, not heuristic detection — predictable and clean. Sicily's airports + the province-capital main rail stations. |
| Hub visual | A **distinct hub pin** (plane / train-building glyph) instead of the bus/stop glyph, so hubs stand out on the map. |
| What the hub sheet shows | A **unified multi-mode departures board** — trains, coaches, urban buses at that hub — merged and sorted by time, each row mode-tagged. |

## Non-goals (YAGNI)

- No heuristic/auto hub detection (curated list only).
- No journey planning from the hub sheet (that's the existing plan flow; the hub
  sheet is a *departures* board, with each row still tappable into the normal
  stop/line views).
- No new upstream data sources — reuse ViaggiaTreno (rail), the coach feed
  (`coachBoard`), and Transitous stoptimes (urban), all already wired.

## Curated hub set

A small static table in the proxy (`server/proxy.js`), each entry: `{ id, name,
kind: 'airport'|'rail', lat, lon, radiusM, railStopId?, vtCode? }`.

**Airports (5):**
- Palermo — Falcone Borsellino (Punta Raisi)
- Catania — Fontanarossa
- Trapani — Birgi / Vincenzo Florio
- Comiso — Pio La Torre
- (Lampedusa — optional, island)

**Main rail stations (province capitals):**
- Palermo Centrale, Catania Centrale, Messina Centrale, Siracusa, Ragusa,
  Agrigento Centrale, Caltanissetta Centrale, Enna, Trapani.

`radiusM` (per hub, ~250–500m) bounds which nearby stops belong to the hub, reusing
the same proximity idea as `clusterStopsByProximity`. `railStopId`/`vtCode` pin the
rail board so we don't have to resolve it each call.

## Architecture

### Detection & pinning (map)
- The map already renders stops/clusters via `/api/map-stops`. Add a step: for each
  curated hub within the viewport bbox, emit a **hub feature** (`kind: 'hub'`,
  `hubId`, `name`, `subkind: airport|rail`, `lat`, `lon`) that renders with the hub
  pin. Nearby member stops within the hub radius are absorbed under the hub (so we
  don't show a hub pin *and* its constituent stop pins).
- Client (`js/mapview.js`): a hub pin taps into `openHubBoard(hub)` (new), analogous
  to `openStopPicker` but calling the combined board endpoint.

### The combined board — new endpoint `GET /api/hub-board`
Params: `hubId` (or `lat/lon/kind`). Returns a single time-sorted list:

```
{ hub: {id,name,subkind}, asOf, departures: [
    { mode: 'RAIL'|'COACH'|'BUS', line, headsign, timeISO, minutes,
      operator, stopName, realtime?: bool, detail? }
] }
```

Server assembles it by fanning out (in parallel) to the sources already in the proxy:
- **RAIL** → ViaggiaTreno partenze for the hub's station (existing VT parsers /
  `resolveVtCode`), giving live train departures.
- **COACH** → `coachBoard` over the hub's coach stop(s) (our feed).
- **BUS (urban)** → Transitous stoptimes for the hub's transit stop(s).

Then: normalize each source into the common `departures` row shape, concatenate,
**sort by `timeISO`**, drop anything already departed, and cap (e.g. next ~40 or next
90 min). Cache briefly (rail is realtime → short TTL, ~30–60s; coach/urban static →
longer). Each row keeps enough identity (`stopId`/line) to tap through into the
existing stop/line detail views.

### Client sheet — `openHubBoard(hub)`
- A bottom sheet titled `{hub.name}` with a mode filter row (All / Trains / Buses,
  reusing the existing Trains/Buses chip pattern) and the merged, time-sorted list.
- Each row: mode icon + line + headsign + "in N min" (or clock) + operator/stop.
  Tapping a row opens that line/stop's existing detail. Realtime rows get the "live"
  treatment already used elsewhere.
- Favoritable, like stops (reuse `favKey`/`isFavStop`).

## Reuse map (what already exists)

| Need | Existing piece |
|---|---|
| Rail departures | ViaggiaTreno parsers, `resolveVtCode`, VT partenze fetch |
| Coach departures | `coachBoard` |
| Urban departures | Transitous stoptimes (`/api/stoptimes`) |
| Proximity grouping | `clusterStopsByProximity` / `haversineM` |
| Bottom sheet + picker UX | `openSheet`, `openStopPicker`, `modeIcon`, chips |
| Favorites | `favKey`, `isFavStop` |

The genuinely new code is: the curated hub table, `/api/hub-board` (fan-out +
normalize + merge-sort), the hub-pin rendering branch in `/api/map-stops` +
`mapview.js`, and `openHubBoard`.

## Testing

Pure, `node --test` (matches the repo):
- `mergeDepartures([...rail], [...coach], [...bus])` → single list sorted by time,
  past departures dropped, capped, mode tags intact.
- Hub-in-bbox selection (a hub inside vs outside the viewport).
- Normalizers: each source row → common shape (times, minutes, line/headsign).
- Absorption: stops within a hub's radius don't also emit standalone pins.

## Open questions for planning

1. Board horizon + cap (next 40 rows? next 90 min? both?).
2. Do island airports (Lampedusa/Pantelleria) ship in v1 or later?
3. Urban-bus volume at big stations can be large — may need a per-mode cap so
   trains/coaches aren't buried.

## Rollout

Standard ManGO:IT deploy: bump proxy version + `version.json`/`js/version.js`,
`npm test`, scp `proxy.js` (+ any client files) to `/opt/mangoit/` + static to
`/var/www/mangoit/`, `pm2 restart mangoit-proxy`, verify `/api/health`.
