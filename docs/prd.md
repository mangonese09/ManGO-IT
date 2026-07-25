# ManGO:IT — Project Doc

*aka "Italy." Sibling app to ManGO (Chicago). Formerly working-named "Mango Trinacria" — name is now locked as **ManGO:IT**.*

**Status:** pre-code. Nothing gets built until this doc is locked.
**Owner:** Mango
**Stack:** Mangonese defaults (see §11)
**Hosting candidate:** `it.mangonese.dev` (recommendation; final call at M0)

---

## 0. Name and positioning

**ManGO:IT** — the `:IT` is the ISO country code for Italy, and the whole thing
reads as "man, go it / just go." It sits alongside ManGO the way a second city
in a transit family would: same brand, same design language, different network.
v1 geography is **Sicily only** (see §4) — the name gives us room to grow to
the mainland without a rename, but nothing in v1 should assume that growth.

ManGO (Chicago) and ManGO:IT share no code by requirement. Steal patterns
freely (staleness badges, departure boards, line maps), but this is a separate
repo, separate Firebase project, separate deploy.

## 1. Problem

Getting between cities in Sicily is harder than it should be. Google Maps transit
coverage on the island is thin — it knows the trains and the two big urban bus
networks, and it does not know the intercity coaches, which are how most people
actually get from Palermo to Agrigento or Catania to Taormina. The coach
timetables exist, but as PDFs, one per operator, buried on a regional government
portal. There is no single view of a trip.

This app is the single view.

## 2. Users

- **v1:** Mango only. Personal app, anonymous auth, no onboarding.
- **Later:** open to the public. Design the data model and rules so this doesn't
  require a rewrite, but do not build for it now.
- No trip is booked. This is speculative — there is no deadline, and no
  hard-coded dates or cities anywhere.

## 3. The core job

**Getting between cities, across every operator, in one place — used on the
ground, mid-trip, on a phone.**

Everything else is secondary. If a feature doesn't serve someone standing at a
bus terminal in Enna trying to work out how to reach Ragusa, it isn't v1.

## 4. Scope

### In v1

| Item | Detail |
|---|---|
| Modes | Regional rail (Trenitalia), intercity coaches (AST, SAIS, Interbus, Etna Trasporti + all other regional-portal operators), urban transit (AMAT Palermo, AMTS Catania) |
| Geography | All of Sicily |
| Routing | A→B itineraries across operators, with transfers |
| Real-time | As much as obtainable — live train status, plus any GTFS-RT feeds that exist |
| Home | A→B search box + nearby departure board, same screen |
| Tabs | Home, Saved, Map |
| Saved | Pinned upcoming departures. Not a multi-day trip planner. |
| Language | English UI. Italian place names kept verbatim — "Siracusa", not "Syracuse" |
| Offline | Cached last-known data is acceptable. No full offline requirement. |
| Ticketing | Informational only: how to buy, where, and a link to the operator's site |
| Platform | Web app on `*.mangonese.dev`, then Capacitor Android wrap |

### Out of v1

- **Ferries and hydrofoils** to the Aeolians, Egadi, Ustica, Pantelleria.
  Explicitly deferred, not rejected — design the operator/mode model so a ferry
  operator slots in without a schema change.
- **Any car or driving feature.** No drive-vs-transit comparison, no ZTL
  warnings, no parking, no fuel. Not in v1 at all.
- Delay/cancellation push alerts.
- **Mainland Italy.** The name allows it; the scope doesn't. Sicily first.

### Non-goals (do not build, ever, without explicit sign-off)

- **Ticket purchase or booking.** The app never sells, reserves, or holds a
  ticket. It explains how to buy one and links out.

Hotels, restaurants, POI, flights, and multi-user trips are simply not in v1 —
they're not forbidden, but don't build them unprompted either.

## 5. Data sources

Everything below was found during research and **must be re-verified before
being relied on**. URLs rot, feeds go stale, unofficial endpoints get closed.

| Source | Type | Endpoint / location | Confidence | Notes |
|---|---|---|---|---|
| Transitous (MOTIS) | REST routing API | `api.transitous.org` | High | Community-run, provider-neutral, free, OpenAPI spec published. Read their usage policy before integrating. |
| AMAT Palermo | GTFS static | `opendata.comune.palermo.it` | High | Actively maintained, republished every ~2 months, covers bus + tram |
| AMTS Catania | GTFS static | `amts.ct.it/open-data` | High | Italian Open Data License v2.0 |
| ATM Messina | GTFS static | `opendata.comune.messina.it` | Low | Published feed appears to cover 2016–2019. Verify freshness; likely dead. |
| Trenitalia / ViaggiaTreno | Unofficial JSON REST | `viaggiatreno.it/infomobilita/resteasy/viaggiatreno/…` | Medium | No auth, no key, no CORS, no SLA. Station autocomplete, departures, arrivals, live train progress. |
| Regione Siciliana coach timetables | PDF | `pti.regione.sicilia.it` → Trasporti Pubblici → Orari Autolinee | High | One folder per operator (AST, SAIS Trasporti, Interbus, etc.). This is the raw material for §7. |
| Ferrovia Circumetnea (FCE) | Unknown | TBD | Unverified | Catania metro + Etna line. Investigate — may have a feed, may not. |

### ViaggiaTreno endpoint shapes (verify before use)

```
/autocompletaStazione/{partialName}     → station names + IDs (IDs look like S08409)
/partenze/{stationId}/{RFC1123 date}    → departure board
/arrivi/{stationId}/{RFC1123 date}      → arrival board
/andamentoTreno/{originId}/{trainNum}/{epochMs} → live progress, delay, platform
```

Known quirks worth handling: `andamentoTreno` returns HTTP 204 with no body for
trains that exist but have no live data — common for cancelled or rescheduled
services. Treat 204 as "no live data", not as an error, and fall back to
scheduled times. The `partenze` response carries cancellation flags that are more
reliable than the absence of an `andamentoTreno` record.

## 6. Architecture

The central bet: **don't write a routing engine.**

```
                   ┌─────────────────────┐
                   │  Client (vanilla JS)│
                   │  mangonese.dev      │
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Cloud Functions    │  ← all secrets, all CORS, all caching
                   └──┬────────┬─────────┘
                      │        │
        ┌─────────────▼──┐  ┌──▼──────────────┐
        │ Transitous     │  │ ViaggiaTreno    │
        │ (routing)      │  │ (live trains)   │
        └────────▲───────┘  └─────────────────┘
                 │
        ┌────────┴────────────────────────────┐
        │ GTFS feeds ingested by Transitous   │
        │  • AMAT Palermo (theirs)            │
        │  • AMTS Catania (theirs)            │
        │  • Trenitalia (theirs)              │
        │  • SICILY COACHES  ← ours (§7)      │
        └─────────────────────────────────────┘
```

We generate a GTFS feed for the Sicilian intercity coaches, host it at a stable
public URL, and submit that URL to the Transitous feeds repository. Their MOTIS
instance ingests it daily and starts returning coach legs in itineraries — for
us and for everyone else. We get cross-operator routing without running a router.

**Fallback if Transitous won't take the feed or the API proves unreliable:**
self-host MOTIS or OpenTripPlanner against a Sicily-only bundle (our GTFS +
Geofabrik's Sicily OSM extract). Same feed, different consumer. Don't build this
until the hosted path actually fails.

**Client rules:**
- No API keys client-side, ever. Everything proxies through Cloud Functions.
- Cache aggressively in Firestore/localStorage. The user is on foreign roaming.
- Every network call is wrapped and degrades to cached data with a visible
  "last updated" timestamp rather than an error state.

## 7. The coach GTFS pipeline

This is the hard part and the entire reason the app is worth building.

**Input:** every operator PDF on the Regione Siciliana transport portal.
**Output:** one valid GTFS zip covering Sicilian intercity coach service, at a
stable public URL, refreshed on a schedule.

### Pipeline stages

1. **Crawl.** Walk the portal's operator folders, enumerate PDF URLs, store a
   hash of each. Only reprocess what changed.
2. **Extract.** PDF → structured text/tables. These are timetable grids: stops
   down the left, trips across the top, times in the cells.
3. **Parse (AI-assisted).** Claude converts each timetable grid to structured
   JSON: route name and code, ordered stop list, trip times, service calendar,
   restrictions. Prompt lives in Firestore `/prompts/{id}` per house convention.
   Every call logs to `/ai_logs/{uid}/{callId}`.
4. **Geocode.** Stop names are free text — "CALTANISSETTA (Via Rochester)",
   "Bv. Graniti". Resolve to coordinates via OSM/Nominatim, cache every
   resolution permanently, and maintain a manual override table. This will be
   the messiest stage. Budget for it.
5. **Emit GTFS.** Build `agency/stops/routes/trips/stop_times/calendar/
   calendar_dates`.
6. **Validate.** Run a GTFS validator in CI. A feed that fails validation never
   ships.
7. **Publish.** Stable URL, daily-checkable, versioned.

### Sicilian quirks the parser must handle

- **Seasonal timetables.** Sheets are marked *periodo invernale* / *periodo
  estivo*. Same route code, different service periods → separate calendar
  entries, not overwrites.
- **Feriale / festivo / scolastico.** Weekday, Sunday-and-holiday, and
  school-term-only runs. Many sheets add "servizio festivo soppresso" on named
  holidays — those go in `calendar_dates.txt` as exceptions, and the holiday
  list has to be resolved to actual dates per year.
- **Boarding prohibitions.** Sheets carry lines like *"divieto di carico da
  Caltanissetta per Enna"* — you may ride through a segment but not board or
  alight within it. Model with `pickup_type` / `drop_off_type` = 1. Getting this
  wrong produces itineraries that are impossible in real life, which is worse
  than no itinerary.
- **Arrival vs departure rows.** Terminals appear twice, marked `A.` (arrivo)
  and `P.` (partenza). Don't emit them as two stops.
- **Inconsistent stop naming.** The same physical stop is spelled differently
  across operators. Deduplicate by proximity, then by name similarity, and
  maintain an alias table.

### Honest risk

"Every operator PDF on the portal" is a large ingestion job, and PDF timetable
parsing degrades badly on scanned or irregularly-formatted sheets. I'd still
build the pipeline generically from day one — but **seed it with AST, SAIS,
Interbus, and Etna Trasporti, prove the output routes correctly end-to-end, and
only then scale to the long tail of smaller operators.** Full coverage is the
target, not the gate.

## 8. Data model (Firestore)

Owner-scoped, `ownerUid` on everything, rules deny cross-user reads.

```
/users/{uid}
/users/{uid}/saved_departures/{id}
    → operator, routeId, tripId, stopId, stopName, scheduledTime,
      lastKnownStatus, lastCheckedAt
/users/{uid}/recent_searches/{id}
/stops/{stopId}              (shared, read-only to clients)
/operators/{operatorId}      (name, modes, ticketing info, website, buy-links)
/prompts/{id}                (system prompts for the parser)
/ai_logs/{uid}/{callId}
/feed_meta/{feedId}          (source URL, hash, last parsed, validation status)
```

Hard delete with a confirmation modal. No soft-delete tombstones.

## 9. Screens

**Home** — A→B search at the top, nearby departure board below it. The board
uses geolocation to find the closest stops/stations across all modes and shows
the next departures with live status where available. This is the screen that
gets opened while standing on a curb; it must be useful in under two seconds.

**Search results** — itineraries as legs. Each leg shows operator, mode, times,
transfer duration, and a live-vs-scheduled indicator. Flag legs where our data
is static-only so the user knows what's trustworthy.

**Leg detail** — full stop list, live position if available, and the ticketing
block: how to buy for this operator, where, and a link out.

**Saved** — pinned upcoming departures with current status, refreshed on open.

**Map** — stops and lines near the user, mode-filterable.

**Settings** — theme toggle, cache clear, data freshness readout per source.

## 10. Real-time behavior

- Trains: poll ViaggiaTreno through the proxy. Cache 60s.
- GTFS-RT: consume wherever a feed exists; Transitous surfaces realtime where
  it has it.
- Coaches: almost certainly schedule-only. **Say so in the UI.** A greyed
  "scheduled" badge is honest; a confident ETA we can't back up is not.
- Every screen showing time-sensitive data shows when it was last fetched.

## 11. Stack and conventions

Mangonese defaults apply in full:

- Vanilla HTML/JS. No framework unless complexity genuinely demands one.
- Firebase + Firestore, Firebase Auth from day one (anonymous is fine for v1).
- Firebase Hosting on `*.mangonese.dev` (candidate: `it.mangonese.dev`).
- Anthropic API for the parser, default `claude-haiku-4-5`, always proxied
  through Cloud Functions. Never a client-side key.
- Mobile-first at 390px. Dark mode default with system detection + manual
  toggle persisted to localStorage. DM Sans. Brand tokens from
  `https://mangonese.dev/shared/mangonese.css`.
- Section header comments (`// ── NAME ──`), sparse inline comments.
- Try/catch every async, user-facing toast on failure.
- Git from day one, private repo, semantic commits, README required.
- No CHANGELOG until there are real users.

## 12. Edge cases

- No connectivity → serve cache, banner the staleness, never blank-screen.
- Geolocation denied → fall back to manual location entry, don't nag.
- Transitous returns no itinerary → say "no route found", show nearest
  alternatives, and offer the operator links rather than failing silently.
- Overnight and cross-midnight trips (GTFS times past 24:00:00).
- Timezone: everything Europe/Rome. Device is likely set to Chicago while
  planning and to Rome while travelling — never trust device timezone for
  schedule math.
- Ferragosto and other Italian holidays that suppress service.
- Strikes (*scioperi*). Common in Italian transit, invisible in GTFS. Out of
  scope to detect, but worth a note in the UI.

## 13. Success criteria

**v1 ships when any A→B within Sicily returns a plausible itinerary.**

Concretely, these should all work:
- Palermo → Agrigento
- Catania → Ragusa
- Trapani → Siracusa
- Taormina → Cefalù
- A rural comune → its provincial capital

"Plausible" means the legs exist, connect with realistic transfer time, and
respect boarding restrictions.

## 14. Build order

| Milestone | Deliverable |
|---|---|
| M0 | Repo, this doc at `/docs/prd.md`, Firebase project, hosting live |
| M1 | Transitous proxy + A→B search + results UI. Trains and the two urban networks only. |
| M2 | Home screen nearby departures, geolocation, Saved tab |
| M3 | ViaggiaTreno proxy, live train status, staleness indicators |
| M4 | Coach pipeline for AST/SAIS/Interbus/Etna → validated GTFS → hosted → submitted to Transitous |
| M5 | Pipeline scaled to remaining portal operators |
| M6 | Map tab, ticketing info per operator |
| M7 | Capacitor Android wrap |

M4 is the milestone that makes the app worth having. Everything before it is
plumbing you could get from Google Maps.

## 15. Working agreement for Claude Code

- **Verify every data source before writing code against it.** Fetch the URL,
  inspect the actual response, confirm the shape. This doc's §5 is research, not
  ground truth.
- Do not scaffold a framework. Vanilla JS unless you can articulate why not.
- Do not invent schedule data. If a source is unavailable, surface the gap in
  the UI.
- No API keys in client code.
- Ask before adding a dependency.
- Bug-fix and QA prompts follow the house standard: session-based testing in a
  real browser via Playwright, driven by user actions, with timelines,
  disruptions, and persistence checks across localStorage/Firestore/UI. Chain
  sessions. No direct function calls, no mocking core services, no asserting on
  internals.

## 16. Open questions

1. Does Transitous accept a third-party-generated GTFS feed for a region, and
   what's the turnaround? Read their contribution docs before committing to §6.
2. Is the Messina ATM feed alive? If not, does Messina have any usable source?
3. Does FCE (Circumetnea) publish anything machine-readable?
4. Are the portal PDFs text-based or scanned? This single fact determines
   whether §7 is a two-week job or a two-month one. **Check this first.**
5. Is `viaggiatreno.it` rate-limited or geo-fenced from a Cloud Functions IP?
