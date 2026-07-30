# ViaggiaTreno live station boards — deep dive (2026-07-29)

Goal: replace the thin MOTIS station schedule (nameless "Bus" rows) with a
**real-time train departures board** for rail stations — train #, category,
destination, delay, platform.

## TL;DR

- **It's ready to build.** The proxy already has the VT plumbing (`/api/vt/*`,
  `slimVtDeparture`, station name→S-code). The board data is rich and live.
- **Resolution is trivial and offline:** a Transitous rail stopId *embeds* the
  VT code. `…otherTRENITALIA:830012002` → `S12002`. No lookup call needed.
- **One parser bug to fix:** `slimVtDeparture` reads `partenzaTreno` (null 5/6
  of the time) for the scheduled time; the right field is `orarioPartenza`
  (epoch) / `compOrarioPartenza` ("21:03").
- **Fallback matters:** bus-substituted lines (e.g. Agrigento) return **0**
  VT departures — correct and honest. Fall back to the MOTIS board there.

## Verified against live VT (2026-07-29)

### Station resolution — two paths, both work
1. **Offline (primary):** strip `8300` from the Transitous Trenitalia stopId.
   `830012002→S12002`, `830012332→S12332`, `830012014→S12014`, `830012216→S12216`.
   Regex: `/(?:TRENITALIA:)?8300(\d{4,6})$/` → `S$1`.
2. **Name fallback:** `GET /api/vt/stations?q=<name>` → `autocompletaStazione`
   returns `PALERMO CENTRALE|S12002`. Use when the stopId doesn't parse.

### Departure boards (`partenze/{S-code}/{when}`) — verified live
- **Palermo Centrale (S12002):** 6 deps — `REG 21840 → TERMINI IMERESE +6'`,
  `REG 6500 → BAGHERIA plat 4`, `REG 5635 → PALERMO AEROPORTO plat 10`, …
- **Catania Centrale (S12332):** `REG 5392 → MESSINA CENTRALE plat 2 (-4')`,
  `IC 727 → SIRACUSA plat 1 (+100')`, `ICN 1960 → ROMA TERMINI`, …
- **Agrigento Centrale (S12216):** **0 departures** (line is bus-substituted).

### Useful raw `partenze` fields (per departure)
| field | meaning |
|---|---|
| `numeroTreno` / `compNumeroTreno` | 21840 / "REG 21840" (ready label) |
| `categoria` / `categoriaDescrizione` | REG / IC / ICN / FR … |
| `destinazione` | "TERMINI IMERESE" |
| `orarioPartenza` (epoch) / `compOrarioPartenza` ("21:03") | **scheduled time — USE THIS** |
| `partenzaTreno` (epoch) | estimated actual dep — often null |
| `ritardo` | delay minutes (can be negative = early) |
| `binarioEffettivoPartenzaDescrizione` / `…ProgrammatoPartenza…` | platform (actual, else scheduled) |
| `nonPartito` / `circolante` / `inStazione` | not-yet-departed / running / at platform |
| `provvedimento` (1) / `tipoTreno` ("ST") | cancelled / rail-replacement |

## Health note
`/api/health.viaggiaTreno` shows `silentDays:1` — but that watch tracks
`cercaNumeroTrenoTrenoAutocomplete` (train-number lookup used by `/api/vt/live`),
which is a DIFFERENT endpoint and is currently returning 0 parses. The **boards
use `partenze`, which is healthy** — verified returning real data. (Follow-up:
the silent-death detector may be watching the wrong signal.)

## Plan

1. **Fix `slimVtDeparture`** — scheduled time from `orarioPartenza ||
   partenzaTreno`; add `clock` = `compOrarioPartenza`; `label` =
   `compNumeroTreno`; keep delay/platform/cancelled.
2. **New `GET /api/vt/board?stopId=…&name=…`** — resolves the S-code (stopId
   embed → name fallback), calls `partenze`, returns `{source:'viaggiatreno',
   departures:[…]}`. On no code / VT error / 0 deps → `{departures:[]}` so the
   client can fall back. (Reuses the 60s partenze cache.)
3. **Client:** in `openStopSchedule`, if the stop is a Trenitalia rail stop
   (`stopId` matches `otherTRENITALIA`), try the VT board first; render a rich
   board (category chip, time, → destination, platform, live delay). If it
   returns empty, fall back to the current MOTIS `stoptimes` board (shows
   replacement buses etc.). Non-rail transit keeps MOTIS.
4. **UI:** row = `[REG] 21:03 → Termini Imerese · Bin 4 · +6′ (live pulse)`;
   negative delay = "on time/early"; cancelled = badge. Source line: "Live —
   Trenitalia (RFI)". Sort by scheduled time.

## Risks / honest limits
- VT is HTTP-only + occasionally flaky/geo-touchy → the proxy already fronts it;
  MOTIS fallback covers outages.
- Boards are short (VT returns ~the next handful, not a full day) — fine for
  "next departures"; note it, no false "full timetable" claim.
- Delay/platform go stale between refreshes → 60s cache + a manual refresh.
- Not every Sicilian rail stop is in Transitous as a rail stop (Cefalù, Enna
  returned none) — name-fallback resolution + MOTIS covers the gap.
