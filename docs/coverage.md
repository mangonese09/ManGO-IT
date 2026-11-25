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

**Triaged page-by-page 2026-08-04 — see `pipeline/data/reports/recovery-verdicts.md`.**
Cancellieri + Mercorillo closed (their PDFs contain no schedule tables — the
zero-route outcome is correct); Sassadoro + Adranone are open-recoverable; the
skipped pages resolve to 11 closed non-timetable pages and 9 prioritized open
items (largest: the Castelmola–Taormina Interbus shuttle page).

## Bottom line

With the current feed published + the Transitous PR merged, Sicily coverage is:
all rail, both major urban networks, 40 extraurban operators, TUA Agrigento —
and the practical gaps that matter are SAIS (scrape next), FCE (free GTFS,
same PR), Prestia (hand-encode), Messina urban (scrape).

## Update 2026-11-25 (research queue item 8)

**Closed since July:** SAIS Autolinee + SAIS Trasporti (pipeline/sais_harvest.py, weekly refresh),
FCE Circumetnea (normalized feed), Prestia e Comandè (6 lines). The Transitous PR merged:
`feeds/it.json` carries Sicilia-intercity-coaches and Sicilia-FCE-Circumetnea from
it.mangonese.dev. **ATM Messina now publishes its own GTFS + GTFS-RT** (atmmessinaspa.it/GTFS,
rt.annacati.com) and is in Transitous, so the Messina urban gap closed without us.

**New risk — the 2025 regional contract.** Since 1 July 2025 extraurban service runs under a
9-year contract in 4 lots held by consortia (COTRAS, COSMO), with the old companies as
subcontractors (Regione Siciliana news 25 Mar 2025). The Region's transport page
(.../mobilita-e-trasporti/trasporto-persone-gomma, updated 03/04/2026) publishes NEW timetable
PDFs: Lot 1 Palermo–Trapani (index + 3 tables, lines 1–344+, 2026-03) and Lot 2 Catania–Ragusa
(2026-04); none yet for Lots 3 (Messina) and 4 (AG/CL/EN). The portal PDFs our feed was built
from (archived 2026-07-25) are marked "in fase di aggiornamento". PDF URLs work only under
`/system/files/2026-03/...` (the page's `/sites/default/files/` links 404).

Lot 1 index vs the live feed's agency.txt (70 agencies, feed_version 2026-11-22): 19 of 24
operators present. **Missing:** Autolinee Lombardo & Glorioso (Cefalù / Madonie, lines 244–249),
BUS AWAY (Castronovo / Prizzi / Lercara, lines 43–48), Adranone (line 1 Sambuca–Partanna, on the
recovery backlog), Servizi Turistici Marrone, Tarantola e Cuffaro.

**Next (build, not research):** add the Lot 1 and Lot 2 PDFs as a pipeline source (same table
parser family as the portal PDFs), diff trips per line against the current feed, and re-check the
Region page monthly for Lots 3–4. Still uncovered: Trapani / Siracusa / Ragusa urban (no public
GTFS found), island buses, ferries.
