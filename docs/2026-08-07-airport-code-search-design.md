# Airport-code search — design note

**Date:** 2026-08-07
**Status:** IMPLEMENTED and LIVE in v1.1.0 (2026-08-07). §5 was settled by measurement, not by a call — see the note there.
**Ask:** typing `PMO` in the Home From/To box should resolve to Palermo Falcone Borsellino airport; `CTA` to Catania Fontanarossa.

---

## 1. Baseline — measured live, not assumed

Against `https://it.mangonese.dev/api/geocode?text=…&place=37.6,14.15` on 2026-08-07:

| Query | Result today |
|---|---|
| `PMO` | **empty** |
| `CTA` | `PLACE "Cta"` in **Paternò** — a confident wrong answer, the worst failure mode |
| `Falcone` | the **town** of Falcone (prov. Messina), not the airport |
| `aeroporto` | works — `STOP PALERMO AEROPORTO` (Cinisi), `STOP Aeroporto` (Catania), + 4 coach stops |
| `palermo airport` | works — `STOP PALERMO AEROPORTO` first |

So the airports **are** reachable; only the *code* form fails. `CTA` returning Paternò is worse than `PMO` returning nothing, because a wrong result gets picked.

## 2. Why it fails

`GET /api/geocode` (`server/proxy.js:1231-1284`) forwards `text` straight to Transitous/MOTIS geocode and merges a substring match over our own `coachStops` index (`proxy.js:1259-1267`). Neither side knows IATA codes. `norm()` (`proxy.js:401`, lowercase + NFD diacritic strip) is the only runtime name transform.

**There is no search-time alias/synonym layer anywhere in the app.** `pipeline/geocode-overrides.json` and `pipeline/stop-renames.json` both look like the right hook and are not — they are Python build-time only and never touch a request. `js/names.js:60-63` has the sole airport-ish rule (`/\bAer\.? ?Font\.?/i → 'Aeroporto Fontanarossa'`) and it is **render-only**, applied in `displayName()`; it does not affect matching.

## 3. Where it belongs — server, not client

Add the alias layer inside `GET /api/geocode` (`proxy.js:1231-1284`), after the `text` clamp at `:1233`.

Rationale: that one endpoint backs the Home From/To suggest (`js/search.js:376`), the Map tab place search (`js/mapview.js:1026`), and the Saved-place search (`js/saved.js:23/658`). Fixing it server-side covers all surfaces at once and inherits the existing 24 h cache (`proxy.js:1238-1240`). A client-side fix would have to be repeated three times and would not be cached.

## 4. The data source already exists

`TRANSIT_HUBS` — `server/proxy.js:826-832`. Curated, coords audited against Trenitalia GTFS 2026-08-02:

```js
{ id, name, kind: 'airport'|'rail', lat, lon, radiusM, railName }
```

Two airport hubs today: `palermo-airport` (Aeroporto Falcone Borsellino, 38.1881/13.1093, railName `PALERMO AEROPORTO`) and `catania-airport` (Aeroporto Catania Fontanarossa, 37.4700/15.0670, railName `CATANIA AEROPORTO FONTANAROSSA`).

Add two fields: `iata` and `aliases: string[]`.

**Trapani-Birgi (TPS) and Comiso (CIY) were deliberately dropped from `TRANSIT_HUBS`** (comment at `proxy.js:816-821`) because their *hub boards* were too thin. That reasoning does not apply to search aliases — a code that resolves to the right coordinate is useful even where the departures board is sparse. Coach stops for both already exist in `server/coach-stops.json` (`AEROPORTO COMISO (Terminal)`, `AEROPORTO TRAPANI BIRGI (Area Bus)`). **Recommendation: alias all four codes, but keep the hub table itself at five entries** — i.e. the alias table is its own thing that *references* hubs where one exists, rather than forcing every alias to become a hub.

## 5. ~~OPEN DECISION~~ — RESOLVED: (b), the coordinate, for all four

**Measured 2026-08-07 before coding, which made the decision for us.** Planning
`38.1881,13.1093` → Palermo Centrale returns the *same* `REG 5636` train as
planning from the rail station's stop id, **plus** the shuttle coach. The
coordinate is a strict superset of option (a) here, and it keeps a fragile
third-party stop id out of our source. The other three airports have no rail
station at all (`CATANIA AEROPORTO FONTANAROSSA` resolves to coach stops, not a
rail node), so the coordinate is the only honest answer there. No per-airport
branching was needed. Original analysis kept below for the record.



This is the one thing that needs the user's call, because the two options route differently:

- **(a) The rail station stopId** via `railName` (`PALERMO AEROPORTO`). The picked suggestion stores `place: <stopId>`, so MOTIS plans from the actual station node — trains resolve cleanly.
- **(b) The hub coordinate** (`38.1881,13.1093`). Stores `place: "38.1881,13.1093"`, which goes through the far-attach walk logic (`FAR_ATTACH_M=6000`) and can reach coach stops the station node might miss.

Palermo has a rail airport station, so (a) works there. **Catania's airport rail link is the weaker case** — verify `CATANIA AEROPORTO FONTANAROSSA` actually resolves to a served Transitous stop before assuming symmetry; if it doesn't, Catania needs (b) while Palermo gets (a), and the alias entry should carry the choice per-airport rather than being a global rule.

**Recommended default: (a) where a served rail stop exists, (b) otherwise, decided per-airport at build of the alias table and verified live for each of the four codes.** Do not guess this — query each `railName` against `/api/geocode` first.

## 6. Implementation sketch

1. **`server/proxy.js:826`** — add `iata` + `aliases` to the airport rows of `TRANSIT_HUBS`; add a separate `AIRPORT_ALIASES` table for TPS/CIY which have no hub.
2. **`server/proxy.js:~1233`** — after the clamp, if `norm(text)` exactly equals an IATA code (or matches an alias), synthesize a result row and `unshift` it before the sort at `:1275`. Exact-code match only — do **not** substring-match 3-letter codes, or `CTA` starts matching every "Catania…" string and the fix becomes noise.
3. **`geoScore` — `proxy.js:916-926`** — a new `type:'AIRPORT'` currently falls through to `bucket = 3`, ranking *below* coach stops. Add an explicit `bucket = 0`. **This is the easiest thing to miss.**
4. **Sicily filter — `proxy.js:1276-1281`** — all four airports are Sicilian so they survive `inSicily()` automatically. No change, but don't let the synthesized row bypass the `.slice(0, 15)`.
5. **`js/search.js:247` `classifySuggestion`** — add an `'airport'` kind, else the row renders with a blank label. Icon: `icons/plane-mango.png` already exists (used for hub pins, `js/mapview.js`).
6. **`js/search.js:294` `rankSuggestions`** — client re-ranks on top of server order; give `airport` a `kindRank` or an exact `PMO` match can still be pushed down.
7. **Tests** — `tests/unit/proxy-helpers.test.js` already imports the hub table as `HUBS` (`proxy.js:1843`). Add: exact-code hit for all four; `CTA` no longer returns Paternò; a non-code query like `aeroporto` still returns today's results unchanged (regression guard).

## 7. Gotchas

- **Deploy:** a `proxy.js` change **must** `scp server/proxy.js root@107.172.39.168:/opt/mangoit/` + `pm2 restart mangoit-proxy`. The weekly refresh scripts deploy only `coach-*.json`, so a data-only deploy silently ships stale server logic — this has bitten this project live before.
- **Version bump:** `package.json` + `version.json` + `js/version.js` + `?v=` in `index.html` + SW `CACHE` name. `npm test` enforces the first three match.
- Client blocks queries under 2 chars (`js/search.js:87`) — 3-letter codes are fine.
- Picked suggestions store only `{ name, place, lat, lon }` (`search.js:397`); `type`/`kind` are discarded, so the airport-ness must be baked into `place` at pick time.
- `norm()` strips diacritics but does not uppercase-fold beyond lowercasing — compare codes lowercased.
