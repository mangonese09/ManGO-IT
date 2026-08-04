# Portal recovery backlog — page-by-page verdicts (2026-08-04)

Method: every page flagged in `qa.md` ("no table detected" / "no monotonic
trips") plus the four zero-route PDFs was triaged by time-token density in its
extraction JSON (`pipeline/data/pages/…`). A schedule page carries dozens–
hundreds of HH:MM tokens; covers, legends, fare sheets and notes carry ~0.

## CLOSED — confirmed non-timetable pages (no schedule data lost)

| Page | times | Verdict |
|---|---|---|
| AutolineeRegionali p002 | 0 | notes/legend page |
| CANCELLIERI p001 | 0 | info sheet — **operator's whole PDF has no schedule table; zero-route outcome is correct** |
| IONICA p009, p010 | 0 | notes pages (operator otherwise fully parsed, 31 routes) |
| LATTUCA p007–p010 | 0 | non-schedule pages (operator's schedule pages parsed in the 2026-07-31 recovery) |
| Mercorillo p001 | 0 | text but no times — fare/info sheet; **zero-route outcome is correct** |
| CAMILLERI p010 | 4 | notes page with stray references |
| ISEA p003 | 6 | notes page |

## OPEN — real timetables in unhandled layouts (parked, priority order)

| # | Page | times | Notes |
|---|---|---|---|
| 1 | **INTERBUS p012** | 2964 | the Castelmola–Taormina shuttle (~57 runs/day) in a regional contract-annex layout: ~57 columns, wrapped rows, and service-class headers whose glyphs interleave ("GR AI O R N A L I E") — parseable from word coords, but day-classification from those garbled headers is high-risk (wrong-day schedules are worse than absent). Needs its own careful pass. |
| 2 | AST prov. ME p008 | 247 | Messina-province AST — real tables |
| 3 | AST prov. ME p018 | 238 | 〃 |
| 4 | CUFFARO Vincenzo p001 | 238 | small operator currently at zero routes from this PDF |
| 5 | SASSADORO p001+p002 | 132 | **zero-route operator IS recoverable** (both pages carry schedules) |
| 6 | SBERNA p002 | 84 | partial-operator gap |
| 7 | Cuffaro (Autotrasporti) p008/p009 | 44/12 | small remainder |
| 8 | Adranone p001 | 38 | zero-route operator, one small table |
| 9 | MAGISTRO p009, TAI p003, LUMIA p007 | 36/36/32 | small remainders |

Each open item needs genuine parser work (new grid-extraction settings or a
new layout family in `grid_parse.py`) — hours per family, not batched into the
1.0 sweep. The four "zero-route PDFs" from `docs/coverage.md` resolve as:
Cancellieri + Mercorillo **closed** (no schedules exist in the PDFs),
Sassadoro + Adranone **open-recoverable** (items 5 and 8).

Ship gate satisfied: nothing is silently missing — every flagged page now has
an explicit closed verdict or a prioritized open item.
