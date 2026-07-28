# Airport & rail-station coverage audit — 2026-07-28

Method: feed analysis (`server/coach-{stops,trips}.json`) + live routing against
`it.mangonese.dev` (`/api/plan` MOTIS, `/api/direct` own coach feed, `/api/via-hub`).
All four Sicilian airports and 13 major rail-station pairs.

## Airports

| Airport | Coach stops in feed | Operators | App result to key cities | Verdict |
|---|---|---|---|---|
| **Catania Fontanarossa** | 12 (≤3km) | SAIS Autolinee, AST, SAIS Trasporti, Interbus, Etna | → Catania (Alibus + 263 coach runs), → Taormina (bus→rail), → Siracusa (FlixBus + 18 Interbus) | **Excellent** |
| **Palermo Punta Raisi** | 1 (SAL, added v0.15.0) | Autolinee SAL | → Palermo C. (airport train), → Agrigento (SAL direct), → Trapani (rail 3-leg) | **Good** (core works) |
| **Comiso (Pio La Torre)** | 1 (36m) | Etna (4), Giamporcaro (2) | → Ragusa (1 weak coach xfer), → Catania (**NONE**) | **Weak** |
| **Trapani Birgi** | **0** | — | → Trapani (**NONE**), → Palermo (**NONE**). MOTIS knows only rail stops 2–3km away (Marausa, Mozia-Birgi); no airport link | **Dark** |

Notes:
- Feed gap ≠ dead end where MOTIS covers the airport: Palermo (airport train) and
  Catania (Alibus/AMTS) route via Transitous even without our coaches. Trapani Birgi
  and Comiso have **no ingested urban/rail network at the airport**, so they depend
  entirely on our coach feed — which is empty/minimal there.
- Palermo Punta Raisi still missing: Prestia e Comandè city↔airport shuttle, and any
  SAIS/Segesta airport services. Core Agrigento corridor now covered (SAL).

## Rail-station pairs (MOTIS/Trenitalia)

All 13 pairs return options — the rail network is well covered. Best-of examples:

| Pair | Best | Mode |
|---|---|---|
| Catania → Taormina | 52 min | rail |
| Catania → Messina | 2h09 | rail |
| Palermo → Messina | 3h27 | rail |
| Palermo → Trapani | 2h07 | bus (rail is slower here — correct) |
| Palermo → Catania | 2h59 | bus (no good direct rail — correct) |
| Catania → Siracusa | 1h45 | bus |

**DEFECT — results not sorted by quality.** Three corridors *lead* with a
pathological option while good ones sit lower in the same response:

- **Catania → Ragusa**: first two itineraries are **10h05 / 10h03** (3-rail milk-runs);
  the **3h39 FlixBus** is 3rd, and a 4h51 rail is 5th.
- **Siracusa → Ragusa**: leads with ~10h (2-rail).
- **Palermo → Enna**: leads with ~12h46.

Cause: MOTIS `timetableView` returns itineraries in departure order, and the app
renders them in that order (flat view) / sorts by departure (whole-day view). A
strictly-**dominated** itinerary (departs no earlier AND arrives no later than
another) is never filtered, so a slow milk-run departing at a similar time leads.

## Latent proxy bug

`/api/plan` always sets `numItineraries=6`. If a client passes `maxItineraries<6`,
MOTIS returns **HTTP 400** (`numItineraries > maxItineraries`). Not triggered today
(the whole-day client uses `maxItineraries=24`), but unguarded.

## Recommended fixes (prioritized)

- **P0 — Trapani Birgi coach harvest.** A whole airport is dark. Real service: AST
  shuttle Birgi↔Trapani, AST/Salemi Birgi↔Palermo. Same harvest pattern as SAL
  (source the operator timetable, add an airport stop, route file → gates → deploy).
- **P1 — Filter dominated itineraries** in `/api/plan` (drop any itinerary with
  `startTime ≤` and `endTime ≥` another). Fixes the 10h-first problem across
  Ragusa/Enna. Cheap, correct, no data work. + guard `numItineraries ≤ maxItineraries`.
- **P2 — Comiso coach harvest** (Etna/SAIS Comiso↔Catania, Comiso↔Ragusa).
- **P3 — Palermo Punta Raisi** — add Prestia city↔airport shuttle.
