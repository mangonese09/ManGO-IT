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

## SAIS Trasporti — SOLVED 2026-07-25: Laser.Orchard JSON web-service

NOT Albatross; the Orchard CMS site proxies an internal booking API as JSON.
TLS chain is broken (curl needs `-k`; Python needs `ssl` verification off).
Base: `https://www.saistrasporti.it/Laser.Orchard.WebServices/webapi/display`

| Query | Returns |
|---|---|
| `?alias=from&lang=it-IT` | 144 localities `{Id, Descrizione, Tpl}` (Tpl=true → regional TPL network; Tpl=false includes national cities: Bari, Bologna, Rome…) |
| `?alias=to&from={id}&lang=it-IT` | valid destinations for an origin (the sale graph; AGRIGENTO → 47 dests) |
| `?alias=search&from={id}&to={id}&type=1&lang=it-IT&departingdate=DD/MM/YYYY&returningdate=DD/MM/YYYY` | runs: `{Orario, Ora_arrivo, Linea, Costo, Info: DIRETTO, Data, Secondi(+arrivo), Tipo: Andata/Ritorno, Tpl}` — payload at `ExternalSearch.ExternalSearchDPart.ExternalSearchFieldExternal.ContentObject.root.ExternalSearchList` |

Key ids: AGRIGENTO 109, CATANIA 106, CALTANISSETTA 114, PALERMO 140, AEROPORTO CT 2153.

**What it does NOT give (unlike Albatross):**
- No intermediate stops per run — city-level OD pairs only.
- No validity calendars — runs exist per queried date only.

**Both gaps are workable, verified live:**
- *Stitching:* the same physical run is consistent across OD queries —
  AG 02:30 →(AG→CL query) CL arr 03:45; CL→CT query has dep 03:45 → CT 05:20;
  AG→CT query shows 02:30 → 05:20. Line 9001, zero-dwell chaining on
  (Linea, Data, arr≈dep). Trip reconstruction = group the OD matrix by
  (Data, Linea) and chain legs.
- *Calendars:* must be INFERRED from a date sweep (e.g. 14 consecutive days →
  weekly pattern + holiday probes). This is weaker than Autolinee's exact
  validities — document the approximation in feed NOTES if shipped.

**Harvest sizing:** filter to Sicily-internal edges (drop national OD pairs —
FlixBus territory, out of v1 scope). Sicilian localities ≈ 100; sale-graph
edges a few hundred; × 14 sweep dates at 1 req/s ≈ a few hours, cacheable.
Stops are city-level → geocode towns via the existing Nominatim path
(precision 'town'), or pin to existing feed stops where names match.

**Open decision before building:** the user's bar for SAIS was "perfect" —
Autolinee met it because calendars are exact. Trasporti calendars can only be
inferred from sampling; ship with documented approximation, or hold until a
better source (their public line PDFs?) is found.

## Verification plan ("perfect" bar)
- Cross-check harvested times against the booking engine's own rendered Orari
  tab for 3 lines × 2 dates (weekday/Sunday).
- P2-8 style: sample Palermo→Catania Monday departures vs the public site.
- All existing gates apply (speed, calendar assertions, topology).
