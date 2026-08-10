# UX backlog decisions — 2026-08-09 (autonomous session, post v1.2.3)

Answers to `2026-08-09-ux-backlog.md`, each investigated before decided.
Item numbers match the backlog. #5 was already closed there.

## 1. From/To hint — DROP it (both fields bare)

Decision: `To — address, town or stop` loses the hint; both placeholders are
just "From" / "To".

- User already leaned this way; benchmark agrees: Google Maps ("Choose
  destination") and Apple Maps never enumerate accepted input types.
- The job the hint did in v0.23 (advertise address search) is now done by the
  type-labeled suggestions themselves ("address", "town", "train station") and
  by the quick-picks dropdown that opens on focus.

## 2. Choose on map — keep the model, add the missing feedback

Benchmark result: centre-fixed pin + map-moves-under-it IS the Google/Apple
pattern, and our implementation already has the live reverse-geocoded readout
and "Move the map to place the pin" hint. What Google has that we lack is
**kinesthetic feedback**:

- the pin LIFTS while the map is panning and settles when it stops
  (movestart/moveend → CSS class, transform + shadow; reduced-motion collapses
  to instant), and
- a fixed **ground dot** under the pin tip marks the exact point being picked —
  without it the pin floats and the precise spot is ambiguous.

Both added; no model change.

## 3. Depart/Arrive-by — fixed width via hidden sizer

The button becomes an inline-grid stacking the visible label over a hidden
`content:"Arrive by"` sizer, so it is always as wide as its widest state and
tracks any future font change. No hardcoded pixel width. Label text moves into
a `<span>` (anonymous grid items can't be explicitly placed over ::after).

## 4. Selected-state convention — mango ring everywhere

Audit: `.filter-chip.active` (v1.2.0 result filters) and `.map-chip.on` (map)
both use the mango border ring; the home `.mode-toggle.active` alone is
neutral, because QA-11 (2026-07-27, "mango is rare") overrode its original
mango ring — and the chips shipped mango AFTER that rule. Majority + newest
convention wins: the QA-11 override is removed for mode toggles (original
mango rules at styles.css:598 resume), and its `.direct-block` half stays.
Selected = mango ring + 600 weight; unselected = dimmed. One convention, three
surfaces.

## 6. Recents — recent DESTINATIONS join the quick-picks dropdown

The route-level recents (from→to chips under Find routes, since v0.9.4)
already exist and stay. The gap the user actually described ("PMO airport
resurfaces") is destination-level recall, and the mainstream pattern is
Google's: focus an empty search field → saved shortcuts, then recent places.

- Empty-field quick-picks now show, below saved places: up to 4 recent
  destinations derived from the existing `recents` store (both endpoints,
  minus "My location", minus anything already saved as a place, deduped,
  newest first).
- Scope answers: it's DESTINATIONS (searches already have the chips); it sits
  under Saved in the same dropdown, never competing with Saved or Nearby
  departures for Home space; it clears with the recents chips (same store —
  no new storage key, deliberately, ahead of the storage-durability work).

## 7. Stop vs station — the merge is RIGHT; the label was lying

Measured: upstream Transitous geocode returns ONE "PALERMO CENTRALE" STOP
carrying `LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,TRAM,BUS` — the station
complex is merged at the source, our `name|town` dedupe never sees two rows.
Its stop-id board serves all modes (probe: 16 BUS + 3 REGIONAL_RAIL). Our own
coach stops use distinct names ("PALERMO (Stazione Centrale)") so they are not
swallowed either.

The defect is `classifySuggestion` labeling first-family-only: a rail+tram+bus
complex reads "train station", hiding the buses from a user who wants them.
Fix: multi-family STOP rows get a compound kind — "train & bus station",
"train, tram & bus station". Icon keeps the highest-priority family. Ranking
keys untouched (no re-measure needed per the ranking rule; verified boardRank
uses type, not kind).

## 8. City labels vs hub pins — label wins, offset, never overlaid

Benchmark: Google/Apple place labels sit beside/below their marker with
collision handling. Our labels are centered on the place point — exactly where
the 40×40 centre-anchored hub disc sits (see the PALERMO/BAGHERIA screenshot).

Fix in `city-labels.js`: labels stay centered by default; at render time each
label's estimated rect is tested against the current hub-pin rects (mapview
registers an obstacle source after `renderHubs`, and re-schedules a label pass
when hubs land, since hubs arrive async after moveend). On intersection the
label tries below-the-disc, then above; below is used even if both fail —
offset beats overlay. Label-vs-label culling (78×26 cells) unchanged; pane
stays above markers per v0.45.6.

## Ship

Client-only (no proxy.js change): v1.3.0, all six version spots, unit tests
for the classify + recents helpers, Playwright measured verification at 390px
(placeholders, equal toggle widths, mango ring, quick-picks rows, pick-mode
lift/dot, label-vs-hub rects) against a local STATIC=1 build, then deploy.
