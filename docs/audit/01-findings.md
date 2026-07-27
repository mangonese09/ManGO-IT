# Phase 1 — Findings (FINAL 2026-07-26, matrix complete)

Severity scale: S1 = produces dead ends / wrong journeys, S2 = degrades
results or trust, S3 = polish. Evidence inline; quantification in
`02-query-matrix.md`.

## 1A. Query matrix — see `02-query-matrix.md`

100 cells (20 pairs × 5 day types), three systems per cell. Headlines:
untuned live dead in 65/100; F-1 tuning rescued 25; our feed alone answers
33 cells the tuned live network cannot; 7 cells dead everywhere. Failure
classes A–H with per-corridor deltas in the matrix doc.

## 1B. Data layer

### F-1 (S1) — `/api/plan` used none of MOTIS's routing controls — **FIXED v0.5.4, now quantified**
Deployed params: searchWindow 6 h, maxMatchingDistance 600 m,
additionalTransferTime 3 min, max pre/post-transit 30 min. The matrix ran
both variants: the tuning alone converts **25 of 100** cells from "no
results" to a usable journey (all of PA→Messina, PA→Cefalù, CT→Taormina,
Gela→CT, plus every school-day rail cell), and repairs absurd routings
(CL→PA 11 h → 2.5 h). Class B/C in the matrix doc.

### F-2 (S1) — duplicate / misgeocoded stops — **consolidation SHIPPED v0.6.0 (261 variants merged), residue now measured**
The matrix caught surviving cases with routing impact:
- `Palermo (via P. Balsamo)` (Camilleri) geocoded 1.6 km west of the real
  terminal — severs the S.Elisabetta line from every other Palermo stop;
  costs PA→AG 3 h 48 min of journey time (CSA 15:03 vs the 11:15 the 09:15
  direct would give). One override in geocode-overrides.json fixes it.
- Siracusa: misgeocoded cluster 4 km SW of town (open country).
- `catania-piazza-giovanni-xxiii` 30 km inland (wrong province).
- ~12 AGRIGENTO stops share one identical town-centroid coordinate
  (transfer topology is accidentally right, but boards/maps are wrong).
Fix direction: blame-driven geocode overrides (tooling exists from the
quarantine-recovery cycle), then a wrong-province sweep in validate.py
(stop >25 km from its route's centroid ⇒ gate).

### F-3 (S2) — ViaggiaTreno is HTTP-only and single-sourced — unchanged
Honest 204 handling, 60 s cache. Phase 3 item: Trenitalia GTFS-RT research.

### F-4 (S2) — `/api/direct` invisible until total failure — **FIXED v0.6.0**
Direct now races plan and renders when ≥15 min faster. The matrix validates
the design: on AG→CT / Modica→CT the live network "succeeds" with 7 h 56 m /
7 h 44 m itineraries while our coaches do 3 h 50 m / 3 h 25 m (class D).
Keep racing post-#2327 as the latency floor (live p95 2.6 s vs ms).

### F-5 (S1, NEW) — Autotrasporti Cuffaro shipped with zero trips
All 9 Cuffaro routes (the PA↔AG flagship corridor's main operator) are
fully quarantined; PA→AG rides on one Camilleri line (5 Mon–Sat runs, none
Sun). Blame tooling exists; this is the highest-value single recovery in
the feed.

### F-6 (S1, NEW) — harvest-horizon cliff renders as fake "no service"
On the school-day column (9/23) our feed goes dark on 9/20 pairs (TPL
summer sheets and SAIS validities end ~Sept 14; SAIS Trasporti swept window
ends 8/16). Refresh automation (weekly Autolinee, monthly Trasporti —
registered today) tracks the horizon, but the client must distinguish
"schedules known through <date>" from "no service" (backlog: feed-horizon
metadata in /api/health + UI copy).

### F-7 (S2, NEW) — Ferragosto thinning: mostly real, one probe wanted
8/20 pairs lose all coach service on 8/15 (observed-authoritative for SAIS
Trasporti; plausible operator suspensions elsewhere), but four pairs run
Sunday 8/9 yet not Ferragosto. One targeted verify probe on 8/15 (both SAIS
systems) would settle it.

## 1C. Performance — complete

Live plan across 200 calls: p50 1.5 s, p95 2.6 s, max 5.6 s. At p95 the
4 s 4G budget is gone before proxy+render. `/api/direct` (in-memory)
answers in ms — the v0.6.0 racing architecture is the right shape; keep it
permanently. Client bundle remains a non-issue (~2.2 k lines, no build).

## 1D. Capacitor — design exercise, not an audit item

No code exists (inventory §6). Deferred to the redesign phase gated on
owner sign-off.
