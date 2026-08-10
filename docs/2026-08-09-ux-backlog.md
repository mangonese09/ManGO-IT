# UX backlog — raised 2026-08-09 (post v1.2.3)

Eight items from the user, verbatim intent preserved. Nothing below is
investigated yet except #5. Do NOT start coding these — several are questions
that need an answer before they are tasks, and #2/#8 need a look at how
mainstream apps do it (per the standing "benchmark against professional apps"
rule) rather than an invented design.

---

## 1. From / To boxes should look the same

Today "To" carries the hint `— address, town or stop` and "From" does not.
Either both get it or neither does. User leans toward dropping it from "To",
but is open to keeping it on both if the hint earns its place.

**Open question:** does a first-time user need the hint at all? If yes it
belongs on both; if no, drop it. Asymmetry is the actual defect either way.

## 2. "Choose on map" pin interaction feels wrong

Current model: the pin is fixed at screen centre and the user drags the MAP
underneath to line it up. User finds this awkward.

**Needs research, not invention.** Check what Google Maps / Apple Maps actually
do for "drop a pin" and set-location flows — note that centre-fixed-pin IS the
Google Maps pattern for "move map to adjust", so the problem may be missing
affordance (no crosshair, no "Move the map to position the pin" label, no
address readout updating live under the pin) rather than the wrong model.
Decide from the benchmark, then change.

## 3. "Depart" / "Arrive by" control resizes with the selection

The box width tracks the label length, so the row reflows when you switch.
Should be a fixed width sized to the longest label ("Arrive by").

Low risk, mechanical. Verify visually at 390px, not by reading CSS.

## 4. Are "Trains" / "Buses & coaches" selected-states consistent?

User believes a mango-orange outline is the established selected-state
convention elsewhere in the app and that these two toggles may not follow it.

**Verify first:** find what the result filter chips (All / Direct / Train /
Bus & coach, added v1.2.0) and any other toggles actually use for selected
state, then make these match. Do not introduce a third convention. If the app
is already inconsistent across surfaces, fix the whole set in one pass.

## 5. Timezone banner — ANSWERED, no work needed

"All times are Italy time — 7 hours ahead of your phone."

This is `deviceZoneGap()` from v1.2.1 and it is working as designed. It renders
ONLY when the device's UTC offset disagrees with Rome; the user sees it because
they develop from the US. On a phone in Sicily it stays silent. It exists as the
diagnostic for the live traveller report that a Chicago-clocked phone made
correct Rome departures look like a +7h conversion bug.

No change. Listed so it is not re-raised.

## 6. Recent / history alongside Nearby departures

Idea: recently searched destinations (e.g. PMO airport) resurface on Home.

**Scope questions before building:** recent SEARCHES or recent DESTINATIONS?
How does it relate to existing Saved/favourites — is this a third list competing
with Saved for the same screen space? Where does it sit relative to Nearby
departures? What clears it? Storage durability was already designed in
`docs/2026-08-09-storage-durability-design.md` — read that first, it likely
covers where this would live.

## 7. "Palermo Centrale" — the stop vs the station

A bus stop and the train station can share a name at the same place. What should
the app show when the user means one and not the other?

**Directly touches the v1.2.3 ranking work.** rankSuggestions now prefers a
boardable stop among equal name matches, so this is live behaviour, not
hypothetical. Note the dedupe in `/api/geocode` is keyed `name|town`, so two
same-named rows in the same town COLLAPSE to one today — that may already be
hiding the bus stop. Worth checking whether the merge is right (one row, both
modes shown) or wrong (user cannot reach the stop they wanted).

## 8. Map labels overwrite the hub icons

See `docs/assets/2026-08-09-map-label-overlap.png` — "PALERMO" and "BAGHERIA"
are painted across the mango airport/hub pins rather than beside them.

Town name matters more than the icon, so the label must win — but it should be
offset, not overlaid. **Benchmark first:** how do Google Maps / Apple Maps place
labels for pinned and favourited locations (typically: label below or to the
right of the pin, with collision detection that hides lower-priority labels
rather than stacking them).

Relevant history: app-drawn city labels were added 2026-08-03 (756 OSM places,
monotonic zoom bands, "labels above pins"). This is that feature's collision
handling, in `js/mapview.js`.
