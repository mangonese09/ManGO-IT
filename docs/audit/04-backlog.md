# Phase 4 — Prioritized backlog (2026-07-26)

Sourced from 01-findings (F-numbers), 02-query-matrix (classes A–H), and
03-competitive (steals 1–6). **STATUS 2026-07-27: owner signed off; items
1–11 SHIPPED (P0 in the feed deploy, P1+P2 in v0.7.0), item 12 design doc
done (docs/capacitor-design.md, build awaiting green light), item 13
research done (docs/gtfs-rt-research.md — no domestic GTFS-RT exists; VT
stays primary with monitoring).**

## P0 — data repairs (small, measured payoff, no design decisions)

1. **Recover Cuffaro PA↔AG** (F-5). Whole operator quarantined on the
   flagship corridor. Blame → override → re-emit; success = Cuffaro trips
   in `/api/direct` PA→AG and matrix cell improves.
2. **Geocode override: `Palermo (via P. Balsamo)`** (F-2). One entry in
   geocode-overrides.json; recovers 1 h 48 m on PA→AG (09:15→11:15 direct
   becomes reachable from the terminal cluster).
3. **Wrong-province geocode sweep** (F-2): Siracusa SW cluster,
   catania-piazza-giovanni-xxiii, then a validate.py gate — stop >25 km
   from its route centroid fails the build.
4. **Ferragosto verify probe** (F-7): one sais_verify + saist_verify run
   pinned to 8/15 to confirm the 8-pair suspension is real.

## P1 — dead-end honesty (matrix class A/F; steal #1 — the #1 complaint)

5. **Triple fallback on empty results**: (a) next-day probe (same query,
   +1 day, "first bus tomorrow 06:30"), (b) `/api/direct` inline (already
   racing — surface it in the empty state too), (c) nearest served town
   suggestion (autocomplete index knows coach towns).
6. **Feed-horizon metadata** (F-6): serve "schedules known through <date>"
   from /api/health (min of per-source horizons); client renders it in
   empty states past the horizon instead of implying no service exists.

## P2 — result presentation (steals 2–6; needs the redesign conversation)

7. Google-style result card: dominant clock pair + proportional leg strip.
8. Worst-transfer-buffer chip (three risk tiers) — our own extension; the
   data is already in every itinerary.
9. Live/scheduled honesty: Transit-style pulse glyph on realtime rows
   (ViaggiaTreno legs), quiet "scheduled" otherwise; keep staleness chips.
10. Line-first nearby board ranked by imminence, two-direction rows.
11. Fixed mode palette + glyphs; binario chip on rail detail sheets.

## P3 — platform

12. Capacitor wrap (M7, PRD): design exercise first (1D) — nav/back
    handling, widget potential, install prompt retirement.
13. Trenitalia GTFS-RT research (F-3) — second realtime source so VT isn't
    a single point of failure.

## Watch items (no action, tracked)

- **PR #2327** (Transitous ingestion): when merged, classes A and D
  collapse into the live path; keep `/api/direct` racing as latency floor
  (p95 live 2.6 s vs ms local). Re-run the matrix that week — it doubles
  as the acceptance test.
- **Monthly SAIS Trasporti refresh** (registered today, first Tue 02:00):
  watch the first run's log (~12 h sweep) on Aug 4.
- Matrix re-run cadence: after any geocode/quarantine repair
  (`python pipeline/audit_matrix.py` — cached cells are free; only
  changed-feed CSA cells move).
