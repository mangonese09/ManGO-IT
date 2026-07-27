# Trenitalia realtime — second-source research (audit F-3 / P3, 2026-07-27)

## Question

ViaggiaTreno is our only realtime source, unofficial and HTTP-only. Is
there an official GTFS-RT (or any second source) for domestic/Sicilian
Trenitalia regional trains?

## Findings

- **No public domestic GTFS-RT exists.** The only Trenitalia GTFS-RT feed
  in the Mobility Database / transport.data.gouv.fr is **Trenitalia
  France** (the Paris–Milan cross-border operation) — useless for Sicily.
- The Italian national access point publishes Trenitalia **schedules**
  (NeTEx/GTFS, which is how Transitous gets them) but **no realtime**
  channel for domestic rail.
- Every third-party integration found (Home Assistant, MCP servers,
  hobby APIs) rides the same unofficial ViaggiaTreno JSON endpoints we
  already use. It is the de-facto standard; there is no better-supported
  alternative today.
- Other unofficial levers exist (Lefrecce app API, RFI station-monitor
  pages) but they are equally unofficial, harder to parse, and add
  correlated fragility (same operator infrastructure), not independence.

## Decision

Keep ViaggiaTreno as the single realtime source, with the existing honest
degradation (204 = no data ≠ error, "scheduled" labels, staleness chips).
Do NOT build a second unofficial scraper — it buys correlated risk, not
resilience. Two cheap mitigations instead:

1. **Detect silent death**: the weekly refresh (or /api/health) should flag
   when VT has returned zero live matches for N consecutive days —
   distinguish "API changed/broke" from "no data right now".
2. **Re-check yearly**: MIT's NAP is under EU pressure (MMTIS regulation)
   to add SIRI/GTFS-RT; when a domestic realtime channel appears there,
   adopt it as primary and demote VT.

Sources: [Mobility Database — Trenitalia France GTFS-RT](https://mobilitydatabase.org/feeds/gtfs_rt/tdg-81654),
[transport.data.gouv.fr — Trenitalia France](https://transport.data.gouv.fr/datasets/horaires-des-trains-trenitalia-france?locale=en),
[Transitland — Trenitalia feeds](https://www.transit.land/operators/o-s-trenitalia),
[ViaggiaTreno](http://www.viaggiatreno.it/infomobilita/index.jsp),
[Home Assistant ViaggiaTreno integration](https://www.home-assistant.io/integrations/viaggiatreno/).
