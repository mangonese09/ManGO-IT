# Phase 1A — Query Matrix (2026-07-26, v0.6.1 feed: 577 routes / 4,772 trips)

20 OD pairs x 5 day types, depart-after 08:00 Europe/Rome. Three systems per
cell:

- **live untuned** — `api.transitous.org` v3 plan with MOTIS defaults (what
  users got before the F-1 tuning shipped in v0.5.4)
- **live tuned** — same query with the deployed proxy params (searchWindow
  6 h, maxMatchingDistance 600 m, additionalTransferTime 3 min,
  max pre/post-transit 30 min)
- **own-feed CSA** — earliest-arrival router over our GTFS zip
  (`pipeline/audit_csa.py`): honors divieto pickup/drop_off flags,
  calendar_dates, 800 m straight-line transfers (~MOTIS default footpath),
  600 m origin/destination attachment. Conservative vs `/api/direct`
  (which chains transfers up to 1500 m).

Cell = best-by-arrival journey `dep→arr (transfers)`. "CSA deps/day" = count
of distinct viable departures 05:00–21:00. Raw upstream responses cached in
`matrix-cache/` (gitignored); summary in `matrix-results.json`. Reproduce:
`python pipeline/audit_matrix.py` (re-runs are cache-hits, no API load).

## Headline numbers (100 cells)

| metric | count |
|---|---|
| live **untuned** dead (no itinerary) | **65 / 100** |
| live **tuned** dead | **40 / 100** |
| cells the F-1 tuning rescued outright | **25** |
| cells only OUR FEED answers (live tuned dead, CSA OK) | **33** |
| cells dead in both live-tuned AND our feed | 7 |
| own-feed CSA dead | 23 (9 = Sept horizon, 8 = Ferragosto) |
| live plan latency | p50 1.5 s, p95 2.6 s, max 5.6 s (n=200) |

## Failure classes

**A. Transitous is coach-blind (30 cells, 6 pairs all-NONE).** Raffadali→CT,
Raffadali→AG, Catania→Enna, Sciacca→PA, Sciacca→AG, Enna→CL return NOTHING
live on every day type, tuned or not — there is no rail there and Transitous
has no Sicilian coach feed. Every one answers from our own data. This is the
whole product thesis, now measured; PR #2327 is the unlock.

**B. The 15-minute default searchWindow fabricates dead ends (25 cells).**
Untuned NONE → tuned OK: PA→Messina (all 5 days), PA→Cefalù (5),
CT→Taormina (5), Gela→CT (5), plus every 9/23 school-day cell on rail
corridors (PA→CT, AG→CT, Modica→CT, Messina→CT, Siracusa→CT). These are
*rail* corridors MOTIS knows — the default window just can't see the next
train. F-1's fix is confirmed at 25% of all queries.

**C. Untuned picks absurd routes even when it answers.** CL→PA untuned:
10:07→21:06 (11 h); tuned: 08:37→11:06 (2.5 h). AG→CT untuned wanders to
16:47 where our coach does 08:00→11:50.

**D. Our coaches beat the live network on real trunks (where both answer).**
AG→CT: 3h50 coach vs 7h56 tuned-live (Δ 4 h). Modica→CT: 3h25 vs 7h44
(Δ 4h19). PA→Messina: 2h40 vs 3h33. PA→CT: SAIS 11:50 arrival beats rail
12:07–12:49 every day. Messina→CT: coach 10:30 vs rail 10:52. Post-#2327,
MOTIS will surface these itself; until then only `/api/direct` racing (F-4,
shipped v0.6.0) shows them.

**E. Rail controls behave (method check).** PA→Termini Imerese and
PA→Cefalù rail wins as expected (55 min / 1h20); Gela→CT (12:49 via
rail+bus) and CL→PA (11:06) also edge our slower coaches. The matrix isn't
rigged toward the feed — where Trenitalia is genuinely better, live wins.

**F. Sept-23 horizon cliff in OUR feed (9 / 20 pairs dead).** TPL summer
sheets + SAIS validities end ~Sept 14; the swept-authoritative SAIS
Trasporti window ends 8/16. A school-day query drops almost half our
corridors. Weekly (Autolinee) + monthly (Trasporti, automated today)
refreshes track the horizon forward, but the cliff is structural: any query
beyond the harvest horizon silently loses coaches. The client should say
"schedules known through <date>" rather than render NONE as fact.

**G. Ferragosto thinning (8 / 20 pairs dead, others degraded).** Largely
*real* (8/15 was inside the SAIS Trasporti sweep — observed no-run is
authoritative; many operators suspend Ferragosto). But four pairs lose
service that Sunday 8/9 has (e.g. Raffadali→CT leg 2, PA→AG); worth one
targeted saist/sais verify probe on 8/15 before trusting fully.

**H. Feed data bugs measured by the matrix (fix targets, see 04-backlog):**
- `Palermo (via P. Balsamo)` (Camilleri) geocoded 1.6 km west of the real
  via Paolo Balsamo → severs the S.Elisabetta line from the PA terminal
  cluster; CSA PA→AG returns 15:03 instead of the 11:15 the 09:15 direct
  would give. One geocode override recovers a 1h48 improvement.
- All 9 Autotrasporti Cuffaro PA↔AG routes shipped with ZERO trips (whole
  operator quarantined) — the flagship corridor runs on one Camilleri line.
- Siracusa has a misgeocoded stop cluster 4 km SW of town (my first matrix
  run used it as endpoint and even rail queries returned NONE from a field).
- `catania-piazza-giovanni-xxiii` sits 30 km inland (wrong-province
  geocode); ~12 AGRIGENTO stops share one identical town centroid.

## Latency (completes 1C)

p50 1.5 s / p95 2.6 s upstream leaves ~1.5 s of the 4 s 4G budget for
proxy+render at p50 but nothing at p95. `/api/direct` answers from memory in
ms — racing it first (shipped v0.6.0) is the right architecture; keep it
after #2327 merges as the latency floor.

## Full matrix


#### Raffadali → Catania  `coach-transfer`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:30→12:25 (2x) | 8 |
| Sat 8/8 | NONE | NONE | 08:30→12:25 (2x) | 8 |
| Sun 8/9 | NONE | NONE | 15:30→21:50 (2x) | 1 |
| Ferr 8/15 | NONE | NONE | NONE | — |
| Sch 9/23 | NONE | NONE | NONE | — |

#### Raffadali → Agrigento  `coach-rural`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:30→09:00 | 10 |
| Sat 8/8 | NONE | NONE | 08:30→09:00 | 10 |
| Sun 8/9 | NONE | NONE | 15:30→16:00 | 1 |
| Ferr 8/15 | NONE | NONE | 15:30→16:00 | 1 |
| Sch 9/23 | NONE | NONE | 08:30→09:00 | 10 |

#### Palermo → Agrigento  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 09:24→13:03 | 09:24→13:03 | 09:00→15:03 (3x) | 11 |
| Sat 8/8 | 10:24→14:03 | 10:24→14:03 | 09:00→15:03 (3x) | 9 |
| Sun 8/9 | 12:24→16:03 | 12:24→16:03 | 09:00→16:25 (3x) | 9 |
| Ferr 8/15 | 12:24→16:03 | 12:24→16:03 | NONE | — |
| Sch 9/23 | 09:23→14:03 (1x) | 09:23→14:03 (1x) | 09:00→15:03 (2x) | 8 |

#### Agrigento → Catania  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 08:51→16:47 (3x) | 08:51→16:47 (3x) | 08:00→11:50 (1x) | 13 |
| Sat 8/8 | 08:51→16:47 (3x) | 08:51→16:47 (3x) | 08:00→11:50 (1x) | 13 |
| Sun 8/9 | 08:51→18:29 (3x) | 08:51→18:36 (2x) | 08:00→11:55 (1x) | 10 |
| Ferr 8/15 | 08:51→18:29 (3x) | 08:51→18:36 (2x) | 08:00→19:50 (1x) | 8 |
| Sch 9/23 | NONE | 08:07→12:49 (1x) | 08:00→18:20 (4x) | 2 |

#### Palermo → Catania  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 08:54→12:37 (2x) | 08:54→12:49 (1x) | 09:00→11:50 (1x) | 14 |
| Sat 8/8 | 09:01→12:04 (1x) | 09:01→12:07 (1x) | 09:00→11:50 (1x) | 13 |
| Sun 8/9 | 09:01→12:07 (1x) | 09:01→12:07 (1x) | 09:00→11:55 (1x) | 12 |
| Ferr 8/15 | 09:01→12:07 (1x) | 09:01→12:07 (1x) | 09:00→18:25 (2x) | 11 |
| Sch 9/23 | NONE | 09:23→12:49 | 14:00→18:20 (1x) | 2 |

#### Catania → Enna  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:05→09:40 (1x) | 15 |
| Sat 8/8 | NONE | NONE | 08:05→09:48 (2x) | 12 |
| Sun 8/9 | NONE | NONE | 09:05→11:00 (1x) | 13 |
| Ferr 8/15 | NONE | NONE | 09:05→10:48 (1x) | 13 |
| Sch 9/23 | NONE | NONE | NONE | — |

#### Siracusa → Catania  `mixed`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 08:34→10:21 (1x) | 08:34→10:21 (1x) | 09:00→12:25 (2x) | 6 |
| Sat 8/8 | 08:34→10:21 (1x) | 08:34→10:21 (1x) | 09:00→12:25 (2x) | 6 |
| Sun 8/9 | 09:30→11:17 (1x) | 09:30→11:17 (1x) | NONE | — |
| Ferr 8/15 | 09:30→11:17 (1x) | 09:30→11:17 (1x) | NONE | — |
| Sch 9/23 | NONE | 08:34→10:30 | 09:00→12:25 (2x) | 6 |

#### Sciacca → Palermo  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:30→10:10 | 12 |
| Sat 8/8 | NONE | NONE | 09:30→11:10 | 10 |
| Sun 8/9 | NONE | NONE | 09:00→10:40 | 5 |
| Ferr 8/15 | NONE | NONE | 09:00→10:40 | 5 |
| Sch 9/23 | NONE | NONE | 08:30→10:10 | 12 |

#### Sciacca → Agrigento  `coach-rural`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:20→10:25 (1x) | 7 |
| Sat 8/8 | NONE | NONE | 08:20→10:25 (1x) | 7 |
| Sun 8/9 | NONE | NONE | 09:00→19:25 (5x) | 1 |
| Ferr 8/15 | NONE | NONE | NONE | — |
| Sch 9/23 | NONE | NONE | 08:20→10:25 (1x) | 8 |

#### Gela → Catania  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | 08:40→12:49 (1x) | 08:07→13:50 (4x) | 11 |
| Sat 8/8 | NONE | 14:50→18:27 (2x) | 08:07→14:50 (3x) | 12 |
| Sun 8/9 | NONE | 04:24→07:58 (2x) | 08:40→13:50 (3x) | 8 |
| Ferr 8/15 | NONE | 04:24→07:58 (2x) | 08:07→18:25 (5x) | 11 |
| Sch 9/23 | NONE | 08:40→12:49 (1x) | NONE | — |

#### Caltanissetta → Palermo  `coach-trunk`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 10:07→21:06 (2x) | 08:37→11:06 | 08:15→11:35 (2x) | 11 |
| Sat 8/8 | 10:07→21:06 (2x) | 08:37→11:06 | 08:15→11:35 (2x) | 10 |
| Sun 8/9 | 10:07→21:06 (2x) | 08:37→11:06 | 10:15→14:40 (1x) | 7 |
| Ferr 8/15 | 10:07→21:06 (2x) | 08:37→11:06 | 18:15→23:10 (3x) | 1 |
| Sch 9/23 | 10:07→20:37 (3x) | 08:29→10:37 (1x) | NONE | — |

#### Modica → Catania  `mixed`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 10:43→18:22 (4x) | 10:43→18:27 (4x) | 09:00→12:25 (1x) | 6 |
| Sat 8/8 | 10:43→18:22 (4x) | 10:43→18:27 (4x) | 09:00→12:25 (1x) | 6 |
| Sun 8/9 | 15:53→18:36 (1x) | 15:53→18:36 (1x) | 12:25→18:25 (2x) | 3 |
| Ferr 8/15 | 15:53→18:36 (1x) | 15:53→18:36 (1x) | 12:25→18:25 (2x) | 3 |
| Sch 9/23 | NONE | 10:43→18:35 (3x) | 09:00→12:25 (1x) | 6 |

#### Milazzo → Messina  `mixed`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:20→09:10 | 13 |
| Sat 8/8 | NONE | NONE | 08:20→09:10 | 13 |
| Sun 8/9 | NONE | NONE | 09:20→10:10 | 3 |
| Ferr 8/15 | NONE | NONE | 09:20→10:10 | 3 |
| Sch 9/23 | NONE | NONE | 08:20→09:10 | 13 |

#### Cattolica Eraclea → Agrigento  `coach-rural`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 09:00→15:03 (3x) | 6 |
| Sat 8/8 | NONE | NONE | 09:00→15:03 (3x) | 6 |
| Sun 8/9 | NONE | NONE | NONE | — |
| Ferr 8/15 | NONE | NONE | NONE | — |
| Sch 9/23 | NONE | NONE | 09:00→15:03 (3x) | 7 |

#### Palermo → Messina  `mixed`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | 10:02→13:35 | 09:00→11:40 | 8 |
| Sat 8/8 | NONE | 10:02→13:35 | 09:00→11:40 | 5 |
| Sun 8/9 | NONE | 10:02→13:35 | 09:00→11:40 | 5 |
| Ferr 8/15 | NONE | 10:02→13:35 | 09:00→11:40 | 5 |
| Sch 9/23 | NONE | 10:02→13:35 | NONE | — |

#### Enna → Caltanissetta  `coach-rural`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | NONE | 08:03→12:45 (3x) | 15 |
| Sat 8/8 | NONE | NONE | 08:03→14:10 (1x) | 15 |
| Sun 8/9 | NONE | NONE | 11:15→14:55 (1x) | 8 |
| Ferr 8/15 | NONE | NONE | 08:03→23:35 (4x) | 14 |
| Sch 9/23 | NONE | NONE | NONE | — |

#### Palermo Centrale → Cefalu  `rail-control`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | 09:27→10:45 | 08:40→12:00 (2x) | 9 |
| Sat 8/8 | NONE | 09:27→10:45 | 08:40→12:00 (2x) | 5 |
| Sun 8/9 | NONE | 08:45→10:07 | 09:00→19:30 (4x) | 5 |
| Ferr 8/15 | NONE | 08:45→10:07 | NONE | — |
| Sch 9/23 | NONE | 09:32→10:45 | NONE | — |

#### Catania → Taormina  `mixed`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | NONE | 08:31→09:57 | NONE | — |
| Sat 8/8 | NONE | 08:31→09:57 | NONE | — |
| Sun 8/9 | NONE | 08:31→09:57 | NONE | — |
| Ferr 8/15 | NONE | 08:31→09:57 | NONE | — |
| Sch 9/23 | NONE | 08:31→09:57 | NONE | — |

#### Messina Centrale → Catania  `rail-control`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 09:04→10:49 (1x) | 09:04→10:52 (1x) | 08:30→10:30 (1x) | 16 |
| Sat 8/8 | 09:04→10:49 (1x) | 09:04→10:52 (1x) | 09:00→10:40 | 13 |
| Sun 8/9 | 09:04→10:49 (1x) | 09:04→10:49 (1x) | 08:30→11:55 (1x) | 15 |
| Ferr 8/15 | 09:04→10:49 (1x) | 09:04→10:49 (1x) | 08:30→18:25 (2x) | 15 |
| Sch 9/23 | NONE | 09:04→10:58 | 09:15→17:15 (4x) | 5 |

#### Palermo Centrale → Termini Imerese  `rail-control`

| day | live untuned | live tuned | own-feed CSA | CSA deps/day |
|---|---|---|---|---|
| Wed 8/5 | 08:58→09:53 | 08:58→09:53 | 08:40→13:40 (2x) | 2 |
| Sat 8/8 | 08:58→09:53 | 08:58→09:53 | 08:40→13:40 (2x) | 2 |
| Sun 8/9 | 08:11→09:00 | 08:11→09:00 | NONE | — |
| Ferr 8/15 | 08:11→09:00 | 08:11→09:00 | NONE | — |
| Sch 9/23 | 08:49→09:57 | 08:49→09:57 | NONE | — |
