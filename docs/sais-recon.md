# SAIS ingestion recon — 2026-07-26 (BUILT: pipeline/sais_harvest.py, shipped in v0.5.0)

> Status update: the harvester below shipped 2026-07-25 (v0.5.0). Key finding
> vs the design: the `?date=` param FILTERS templates to that exact day, so the
> harvester sweeps 5 full weeks instead of fetching one date per line, and
> merges by templateId. Cross-verification (pipeline/sais_verify.py) passes
> trip-by-trip on out-of-sweep dates. SAIS Trasporti recon still open.

## SAIS Autolinee — SOLVED: full unauthenticated timetable API (Albatross v8.3)

Base: `https://api.saisautolinee.it/` (UA required by our own policy; no auth for these):

| Endpoint | Returns |
|---|---|
| `GET /stops` | **1,417 stops with exact lat/lon**, names, ids, externalId — no geocoding needed |
| `GET /lines` | 120 lines: id, code, description, statGroup (urban pools + TPL), `dismissed` flag |
| `GET /routestimetables/timetable?lineIds={id}&date=YYYY-M-D` | per direction: routeCode, description, `tripTemplates[]` each with `stops[] {stopId, stopTime{days,hours,minutes}, timeFromPrevious}` and `validities[] {validityFrom/To, frequency{daysOfWeek…, nationalHolidays, excludeNationalHolidays}, exceptions[]}` — **exact calendars, no school-year approximation** |
| `GET /routestimetables/activeStops?lineIds=…&date=` | stop ids active per line/date |
| `GET /locations/from`, `/locations/to?departure={locId}` | city-level P2P sale graph (used for corridor mapping) |
| `POST /trips` | requires auth ("authentication error") — NOT needed given /timetable |

Corridor coverage confirmed via locations graph: Palermo↔Catania(+Aeroporto),
Messina↔Catania/Palermo, Enna, Caltanissetta, Gela, Piazza Armerina,
Caltagirone, Modica/Ispica/Comiso (southeast), national lines (Rome/Milan/…).
Urban pools: Enna, Augusta, Gela, Milazzo, Modica, Scicli, Siracusa.

### Harvester design (sais_harvest.py)
1. Pull /stops + /lines once (cache with sha256, like the PDF manifest).
2. For each non-dismissed line: GET /timetable for ONE date (validities carry the
   full calendar — date param appears to just filter; verify by diffing two dates).
3. Map: line→route, tripTemplate→trip (validities→calendar_dates via exact
   from/to + weekday flags + holiday rules + exceptions), template stops→stop_times
   (stopTime has day-offset for overnight), stopId→coords from /stops.
4. Emit as route JSONs in the pipeline contract (or straight to GTFS rows) with
   agency SAIS Autolinee; run through existing emit/validate gates.
5. Politeness: ~120 requests total, 1/s, our UA. Refresh weekly.
6. National lines: include only Sicily-internal segments? DECISION: include whole
   line (Transitous is international) but mark agency correctly.

## SAIS Trasporti — separate system, recon needed

- `api.saistrasporti.it` does not resolve/connect — NOT Albatross.
- Site: `saistrasporti.it/it-IT/ricerca-orari-e-linee` (ASP.NET). WebFetch fails
  on their TLS (self-signed intermediate?); use browser or curl -k next session.
- This company holds **Agrigento↔Catania(+airport)** — the corridor that makes
  Raffadali→Catania work — plus Palermo↔Caltanissetta etc.

## Verification plan ("perfect" bar)
- Cross-check harvested times against the booking engine's own rendered Orari
  tab for 3 lines × 2 dates (weekday/Sunday).
- P2-8 style: sample Palermo→Catania Monday departures vs the public site.
- All existing gates apply (speed, calendar assertions, topology).
