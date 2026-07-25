# Prescriptions captured from seed sheets

Rules that GTFS cannot express are listed here rather than silently dropped
(PRD: wrong restrictions are worse than none).

## AST 702 (Montevago - Palermo)
> "Divieto di esercizio locale estremi inclusi Montevago - Santa Margherita Belice e viceversa"

OD-pair prohibition: passengers may not travel ONLY between Montevago and
S. Margherita Belice on this line (both boarding and alighting there on longer
journeys is fine). GTFS has no OD-pair restriction mechanism; pickup_type /
drop_off_type would wrongly block legitimate longer trips. Left unmodelled;
itineraries between those two towns on route ast-702 are impossible in
real life. Revisit if MOTIS gains support for fare/OD rules.
