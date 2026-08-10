# Backlog: richer ticketing info on the result sheet

Captured 2026-08-09 from a user request. Not started — design first.

## Ask 1: link coach operators to their website

Trenitalia's sheet effectively sends you somewhere you can buy. Coach operators
don't, and should at least link to their own site even when online purchase
isn't possible.

**Likely mostly a rendering gap, not new architecture.** `js/operators.js`
already defines a `website` field (Trenitalia has one). Two things to check
before designing anything:

1. Does the trip-detail sheet render `website` at all, or only `howToBuy`?
2. Which coach operators are missing a `website` value? (AST, SAIS Autolinee,
   SAIS Trasporti, Interbus, Etna, Cuffaro, Camilleri Argento, Lumia, Salemi,
   F.lli Patti, Prestia e Comandè, TUA Agrigento…)

Verify each URL is live before shipping it — per the project working
agreement, never code against an unverified source. A dead operator link is
worse than no link.

Stays inside the PRD non-goal (informational only, never sell or reserve).

## Ask 2: "closest ticket desk" instead of dead text

Today `howToBuy` says things like "buy at the ticket desk or call this number".
The ask: make that tappable and point at the nearest place to actually buy.

**This is the hard one, and it has a data problem.** We do not hold ticket
office locations, and Sicilian coach tickets are commonly sold at bars and
tabaccherie near the stop rather than at an operator counter.

Candidate sources, none clean:
- OSM `shop=ticket`, `vending=public_transport_tickets` — sparse coverage
- OSM `shop=tobacco` — dense, but a tabaccheria near a stop is NOT proof it
  sells that operator's tickets
- Operator sites list their own biglietterie — accurate but manual, per-operator

**The tension to resolve first:** "nearest tabaccheria" presented as "where to
buy your ticket" is exactly the confident-wrong-answer failure this app is
built to avoid — the same class as `CTA` resolving to a hamlet in Paternò.
Sending someone to a shop that doesn't sell their ticket, when they're trying
to catch a coach, is a real-world cost.

Options to weigh in the design session:
- (a) only show verified operator biglietterie, accept sparse coverage
- (b) show OSM candidates but label them honestly as "may sell tickets"
- (c) show the operator's own outlet list as a link, no map/proximity claim

Recommend starting at (a)/(c) and earning (b) only with evidence.

## Order

Ask 1 is small and independent — likely shippable on its own once URLs are
verified. Ask 2 needs a proper brainstorm and probably a data-sourcing pass.
