# Sicily bus coverage audit — 2026-07-25

What ManGO:IT's routing will and won't know, operator by operator. "In Transitous"
means routable today; "our feed" means routable once the ManGO:IT GTFS is
ingested by Transitous.

## ✅ Covered

| Network | Source | Status |
|---|---|---|
| Trenitalia regional rail | Transitous (NeTEx) | live in Transitous |
| AMAT Palermo (urban bus+tram) | their GTFS | live in Transitous |
| AMTS Catania (urban, incl. Alibus airport) | their GTFS | live in Transitous (389 stops verified) |
| FlixBus long-distance | their GTFS | live in Transitous |
| Regional portal extraurban: 71 of 75 operator PDFs → 475+ routes, 40 operators (AST all 7 provinces, Interbus, Etna Trasporti, Cuffaro, Lumia, Giuntabus, Camilleri Argento, Cacciatore, Lattuca, Segesta, Ionica, …) | our feed | published, awaiting Transitous PR |
| TUA Agrigento urban (L1 Valle dei Templi, L2 San Leone, L2/ Tempio di Giunone) | our feed (their PDF) | parsed 2026-07-25, 76 trips |

## 🔶 Known gaps, source identified (priority order)

1. **SAIS Autolinee + SAIS Trasporti** — THE big intercity gap: Palermo–Catania,
   Palermo/Catania–Messina, Enna, Caltanissetta, Gela, airport runs. Never
   archived from the portal. Their sites publish per-line timetables
   (saisautolinee.it/en/sais-autolinee-timetables, saistrasporti.it/it-IT/ricerca-orari-e-linee)
   → scraping project, next pipeline session.
2. **FCE Circumetnea (Catania metro + Etna railway + bus)** — publishes OFFICIAL
   GTFS (validity through 2028-02): circumetnea.it → "Pubblicazione orari TPL in
   formato GTFS". Not in Transitous yet → trivial second source entry in the
   same Transitous PR. PRD open question #3: answered YES.
3. **Prestia e Comandè (Palermo airport ↔ city, every 30 min)** — no GTFS, but a
   fixed clock-face schedule (04:00–22:30 from city / 05:00–00:30 from airport);
   hand-encode into our feed as a small static route. Huge tourist value.
4. **ATM Messina (urban tram + bus)** — their old GTFS died in ~2019 (PRD was
   right). Site publishes orari → scrape candidate, medium effort.

## ⬜ Smaller urban networks (later; tourist-relevance ordered)

- ATM Trapani (urban + Erice funicular connection buses)
- Siracusa urban (AST urban network — NOT in the extraurban portal PDFs)
- Ragusa/Modica urban (AST/Tumino urban)
- Marsala, Mazara, Vittoria, Gela, Caltanissetta (SCAT), Enna urban
- Aeolian/Egadi island buses (URSO Lipari, Favignana) — pairs with the deferred
  ferry mode (PRD out-of-v1)

## Portal recovery backlog

- 4 PDFs produced zero routes: Adranone, Cancellieri, Mercorillo, Sassadoro
  (1–2 pages each, layout oddities)
- 32 pages skipped inside otherwise-parsed PDFs (see pipeline/data/reports/qa.md)

## Bottom line

With the current feed published + the Transitous PR merged, Sicily coverage is:
all rail, both major urban networks, 40 extraurban operators, TUA Agrigento —
and the practical gaps that matter are SAIS (scrape next), FCE (free GTFS,
same PR), Prestia (hand-encode), Messina urban (scrape).
