# ManGO:IT — project summary (for external review)

**One-liner:** a personal PWA that gives a single view of getting between cities in
Sicily — regional rail, ~40 intercity coach operators, and urban networks — with
live train status, built for use on the ground mid-trip. Live at
https://it.mangonese.dev. The differentiator: Sicily's intercity coach timetables
existed only as PDFs on a regional government portal, so the project built the
first GTFS feed for them and submitted it upstream so *any* router can use it.

## Problem

Google Maps' transit coverage in Sicily is thin: it knows Trenitalia and the two
big urban networks (Palermo, Catania), but not the intercity coaches that are how
people actually get from Palermo to Agrigento or Catania to Ragusa. Those
timetables exist as ~75 PDFs (one per operator) on a portal that is only
reachable from Italian IPs.

## Architecture (the central bet: don't write a routing engine)

- **Client:** vanilla JS PWA, no build step, no framework. localStorage behind a
  storage-adapter module (Firebase Auth/Firestore is a planned swap, deliberately
  deferred). Dark-mode default, mobile-first at 390px, service worker with
  cache-first shell.
- **Server:** one zero-dependency Node proxy (~350 lines) on a VPS under pm2,
  fronted by nginx + Let's Encrypt. It wraps two upstreams — **Transitous**
  (community MOTIS instance, does all routing) and **ViaggiaTreno** (unofficial
  Trenitalia JSON API, live train delays) — adding caching, response slimming,
  rate limiting, and input caps. No API keys anywhere.
- **Data pipeline (python + pdfplumber, the hard 80%):** PDF timetables → GTFS.
  Stages: crawl (via Wayback Machine CDX, since the live portal is geo-fenced;
  sha256 provenance manifest) → extract (word coordinates; vertical/overprinted
  text reconstructed) → deterministic grid parse (corsa columns by x-position,
  handles 3 layout families incl. comma-decimal times) → assemble (direction
  auto-detected by time monotonicity, arrival/departure terminal rows merged,
  service classes like feriale/festivo/scolastico decoded from interleaved
  vertical labels via subsequence matching) → geocode (Nominatim with permanent
  cache, street→town fallback, km-interpolation between neighbours for
  un-geocodable road junctions) → emit GTFS (calendar_dates-only calendars with
  explicit date math incl. Italian holidays and the school year) → structural
  validation gate (a feed that fails does not ship).

## State

- App v0.3.4 live: A→B search with autocomplete (deduped, province context,
  transit-stop-first ranking, own coach stops merged in), destination-first flow
  (pick a destination → auto-locate → search), nearby departure board, pinned
  departures, live Trenitalia delay per rail leg, per-operator ticketing info
  (informational only — never sells tickets, a hard non-goal), staleness
  indicators on every screen, Europe/Rome time math regardless of device TZ.
- Feed: 71/75 portal PDFs parsing → ~475 routes / 40 operators / thousands of
  trips, plus TUA Agrigento urban (Valle dei Templi + San Leone tourist lines,
  parsed from the operator's own PDF). Published CC-BY 4.0 (attribution: Regione Siciliana + operators) at a stable URL.
- Upstream: PR open against `public-transport/transitous` adding our feed + FCE
  Circumetnea's official GTFS (Catania metro / Etna railway). Once merged and
  imported, coach legs appear in routing results for us and everyone else.
- 18 unit tests incl. version-sync enforcement; Playwright visual sweeps of all
  screens in both themes; coverage audit doc mapping every known Sicilian
  operator to covered/gap/backlog.

## Honest caveats

- Source timetables are Wayback snapshots (mostly Aug 2024; Interbus Nov 2025) —
  the live portal is unreachable from outside Italy. Regeneration planned when
  fresher sheets are obtainable.
- School-year calendars approximated to ±a few days; Sicilian school decrees vary.
- ~30 of 507 timetable pages still unparsed (odd layouts, cover pages).
- Some stop coordinates are town-centroid or km-interpolated precision.
- An OD-pair "divieto di esercizio locale" rule is approximated conservatively
  (pickup/drop_off restrictions that eliminate the illegal short-hop without
  blocking legal longer journeys) and documented.
- Known gaps with identified sources: SAIS (the Palermo–Catania–Messina trunk
  operator; site scrape planned), Prestia e Comandè airport shuttle (hand-encode),
  ATM Messina urban (their GTFS died in 2019).

## Questions for review

1. Architecture: is Transitous-as-sole-router an acceptable single point of
   failure, given the documented fallback (self-host MOTIS against the same
   feed + OSM extract) that we've chosen not to build until needed?
2. Data ethics/quality: is shipping 2024-snapshot schedules with prominent
   staleness disclosure the right call vs. waiting for fresher data?
3. The pipeline is deterministic (no LLM in the loop at runtime); parsing
   was verified by spot-checks against source sheets plus structural
   validation. What additional validation would you add before wider use?
4. Anything about the GTFS modelling choices (calendar_dates-only, pickup/
   drop_off handling, town-level stop precision) that would cause bad
   itineraries rather than just imprecise map pins?
