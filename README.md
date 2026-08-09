# ManGO:IT

Sicily intercity transit in one view — regional rail, intercity coaches, and urban
networks across every operator, routed A→B with live train status. Built for use
on the ground, mid-trip, on a phone.

## Tech stack

- Vanilla HTML/JS PWA, no build step. Brand tokens from `mangonese.dev/shared/mangonese.css`.
- Node zero-dependency proxy (`server/proxy.js`) → [Transitous](https://api.transitous.org) (routing) + ViaggiaTreno (live trains).
- Storage: localStorage behind an adapter (`js/store.js`). Firebase Auth + Firestore mirror is a planned fast-follow (single-user v1 doesn't need sync yet).
- Hosting: VPS nginx at `it.mangonese.dev`, proxy under pm2.

## Run locally

```
STATIC=1 node server/proxy.js     # serves app + API on http://localhost:3041
npm test                          # unit tests (node --test)
```

## Env vars

None. No API keys anywhere — Transitous and ViaggiaTreno are keyless; the proxy
exists for CORS, caching, and response slimming.

## Deploy

1. Bump version in `package.json`, `version.json`, `js/version.js`, `?v=` tags in
   `index.html`, and `CACHE` in `service-worker.js` (version-sync tests enforce most of this).
2. `scp` changed files to `<vps>:/var/www/mangoit/   # host in private deploy notes`
   (server changes: also scp `server/proxy.js` + `coach-*.json` to `/opt/mangoit/` and `pm2 restart mangoit-proxy`).
3. Verify: `curl -s https://it.mangonese.dev/api/health`

## Milestones

M0 repo/hosting ✅ · M1 routing+search ✅ · M2 nearby board+saved ✅ · M3 live
trains+staleness ✅ · M4 **coach GTFS pipeline** (the whole point) · M5 long-tail
operators · M6 map tab · M7 Capacitor Android wrap.

## 1.0 scope decisions (deliberate, not gaps)

- **Coach fares are informational states, never invented numbers.** Urban flat
  fares are exact (open data); SAIS ships its published OD fare table;
  everything else shows an honest `counter`/`booking` state with how-to-buy
  text. Full OD fare tables for AST/Interbus bands are out of scope until an
  operator publishes them.
- **Accountless by design.** Saved places/favourites live in localStorage
  only. This is a deliberate exemption from the house Firebase-from-day-one
  rule: the app has no per-user server data, sells nothing, and works fully
  offline-first; adding auth would add surface without function. Revisit only
  if cross-device sync is actually wanted.
- **"Leave earlier and wait longer" is not a hideable result — it does not
  exist.** Transitous/MOTIS uses range-RAPTOR, which identifies a journey by its
  arrival time and reports it at the *latest* departure achieving that arrival.
  So on a sparse corridor where six trains feed one onward coach, only the last
  useful train is ever returned — at any layer, with any window or page cursor
  (verified by stepping 1-hour windows across an empty Sunday afternoon). Our
  `dropDominated` in `server/proxy.js` is a second pass that removes only
  same-departure duplicates. A "show suppressed departures" toggle would
  therefore be a control that does nothing; surfacing earlier runs of the *first
  leg* is the real version of that feature, and is not built yet.
- **No ferries / island buses** (PRD non-goal) and **no bus GTFS-RT** —
  none exists in Sicily (docs/gtfs-rt-research.md); ViaggiaTreno live status
  for trains is the realtime ceiling. The app says "scheduled" honestly
  rather than faking liveness.

## Licensing & usage

Code: MIT. Generated GTFS feed: **CC-BY 4.0** with attribution to Regione
Siciliana and the source operators. The app never sells or books tickets
(hard non-goal) and is strictly non-commercial, per the
[Transitous usage policy](https://transitous.org/api/).

## PRD

[docs/prd.md](docs/prd.md) — locked before any code was written. §7 (coach PDF →
GTFS → Transitous pipeline) is the reason this app exists.
