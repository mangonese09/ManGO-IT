# Phase 1 — Findings (DRAFT — query matrix pending v0.6.0 ship)

Severity scale: S1 = produces dead ends / wrong journeys, S2 = degrades
results or trust, S3 = polish. Evidence inline.

## 1B. Data layer

### F-1 (S1) — `/api/plan` uses none of MOTIS's routing controls
Verified against MOTIS `openapi.yaml` (v3): the API accepts `searchWindow`,
`maxTransfers`, `minTransferTime`, `additionalTransferTime`,
`transferTimeFactor`, `maxPreTransitTime`/`maxPostTransitTime`,
`maxMatchingDistance` (default **250 m**), `slowDirect`, `timetableView`,
`via`. Our proxy sends only from/to/time/arriveBy/numItineraries.
Consequences on a sparse rural network:
- Default search window on a day with 3 runs can look like "no results"
  when the next run is outside the window → **dead ends of the worst kind**.
  Fix: widen `searchWindow`, and/or probe +1 day for the no-results rule.
- `maxMatchingDistance` 250 m: a town-centroid-geocoded rural stop can sit
  >250 m from the road graph → origin/destination unmatchable → dead end.
- `additionalTransferTime=0`: zero cushion on coach-to-coach transfers that
  run hourly; one late coach = stranded. We should set a floor.
Impact: several matrix failure classes may be tunable to success without
any data change. To quantify in the matrix (tuned vs untuned columns).

### F-2 (S1) — 573 likely-duplicate stop pairs inside our own feed
Scan: same town prefix, <120 m apart, ≥2 shared name tokens, different
stop_ids → 573 pairs in the 2,879-stop feed. Examples: three spelling
variants of RAFFADALI (Via Nazionale) at 0–85 m; three of LENTINI (piazza
Sofisti) at 0 m; case variants of CATANIA (piazza Giovanni XXIII°).
Cause: stop identity is the verbatim per-operator sheet spelling.
Consequences: fragmented departure boards, MOTIS sees distinct nodes so
cross-operator transfers depend on generated walk links instead of being
same-stop, and autocomplete shows dupes. This is the brief's "duplicate
stops silently kill transfers," confirmed in our own data.
Fix direction: a consolidation stage in emit (cluster <60 m + normalized
name equality → one canonical stop; keep aliases for search). Needs care
with the divieto topology assertions.

### F-3 (S2) — ViaggiaTreno is HTTP-only and single-sourced
Live train status rides an unofficial API over plain HTTP; 204s are handled
honestly (no-data ≠ error), 60 s cache. No GTFS-RT anywhere else. Risk:
silent total loss of realtime if VT changes; mitigation is labeling (already
honest) — no action beyond Phase 3 source research (Trenitalia GTFS-RT).

### F-4 (S2) — `/api/direct` is invisible until total failure
The degraded fallback triggers only when plan fails or returns zero. The
PA→AG probe shows Transitous returning a *worse* itinerary (3h53 via
Trenitalia rail-replacement bus) while our feed holds ~2h coaches — the
fallback never fires because plan "succeeded." Until PR #2327 merges, known
direct coaches should render alongside weak plan results, not only on empty.

## 1C. Performance (initial numbers, full pass with matrix)

- Transitous v3 plan, PA→AG, warm CDN, from this network: **2.0 s** —
  already at the brief's 4G budget with zero headroom for proxy+render;
  worst-case Transitous responses take up to our 45 s proxy timeout with no
  early abort to the fallback. Consider racing `/api/direct` in parallel
  and rendering it first (it answers in ms from memory).
- Client bundle is ~2.2 k lines total vanilla JS, no build step — bundle
  weight is a non-issue; the risk sits entirely in network waterfalls.

## 1A / 1D — pending

Query matrix (both baselines, tuned/untuned) after v0.6.0. Capacitor: no
code exists (inventory §6); 1D is a design exercise, not an audit of
existing behavior.
