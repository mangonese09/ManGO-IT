# Sicily coaches GTFS pipeline (M4)

PDF timetables → one validated GTFS zip at a stable URL. The reason ManGO:IT
exists (PRD §7).

## Stages

| Stage | Script | Notes |
|---|---|---|
| Crawl | (Wayback CDX) | The live portal `pti.regione.sicilia.it` is unreachable from outside Italy (TCP hangs/refuses). All PDFs come from Wayback Machine snapshots via the CDX API; `data/pdfs/manifest.json` records source URL, snapshot timestamp, and sha256 per file. 75 operator PDFs exist in the archive (full M5 long tail). |
| Extract | `extract.py` | pdfplumber → per-page word boxes + layout lines + per-corsa service labels (vertical header text reconstructed by x-clustering). All 10 seed PDFs are **text-based, none scanned** (PRD open question #4: the good outcome). |
| Parse | `grid_parse.py` | Deterministic grid parser: corsa columns from number-row x-centres, times snapped to nearest column, both layout families (single two-direction table; repeated per-direction tables). |
| Assemble | `assemble.py` + `seed_routes.json` | Trips per corsa, direction auto-detected (first-vs-last time), A./P. terminal pairs merged, service classified from label keywords via subsequence matching (handles interleaved vertical text). Non-monotonic trips are dropped and reported, never shipped. |
| Geocode | `geocode.py` | Nominatim (1.1s delay, permanent cache in `data/geocode-cache.json`, overrides in `geocode-overrides.json`), street→town fallback, km-interpolation between geocoded neighbours for road junctions ("BV."). Precision recorded per stop. |
| Emit | `emit_gtfs.py` | calendar_dates-only calendars: exact date sets per service (feriale/festivo/scolastico/seasonal). Window 2026-08-01 → 2027-07-31. |
| Validate | `validate.py` | Referential integrity, monotonic times, Sicily bbox, ≥2 stops/trip. **A feed that fails does not ship.** |

Run: `python pipeline/extract.py && python pipeline/grid_parse.py && python pipeline/assemble.py && python pipeline/geocode.py && python pipeline/emit_gtfs.py && python pipeline/validate.py`

Build dependency: `pip install pdfplumber` (pipeline only, not the app).

## Honest caveats (also see NOTES in the feed)

- **Snapshot staleness.** AST/Etna sheets are Aug 2024 snapshots, Interbus Nov 2025.
  Sicilian intercity timetables are quite stable year-over-year, but this feed
  should be regenerated whenever fresher PDFs are obtainable (from inside Italy,
  the live portal works; operator sites are an alternative source).
- **School calendar approximated** (2026-09-14 → 2027-06-08 + Christmas/Easter
  breaks). The regional decree shifts by a few days each year.
- **`Divieto di esercizio locale` prescriptions** (OD-pair prohibitions, e.g.
  AST 702 Montevago↔S. Margherita) are **not expressible in GTFS** and are
  documented in `data/reports/prescriptions.md` rather than silently dropped.
- **Seed scope:** 5 routes / 3 operators (AST, Interbus, Etna Trasporti),
  116 trips. SAIS is absent from the archive (their PDF was never captured) —
  source it from saisautolinee.it in M5. Scaling to the remaining ~65 operators
  is M5; the parser families cover the layouts seen so far.

## Output

`pipeline/dist/sicily-coaches.gtfs.zip`, published at
`https://it.mangonese.dev/gtfs/sicily-coaches.gtfs.zip` (license: CC0 for the
compilation; the underlying schedule facts are published by Regione Siciliana).
