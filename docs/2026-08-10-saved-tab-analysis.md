# Saved tab analysis — 2026-08-10 (v1.7.1 live)

Measured live walkthrough (empty + populated states, icon picker, DOM
measurements) plus a read of the full render/interaction code, compared to
Google Maps Saved, Apple Maps Favorites, Citymapper (Home/Work), and Transit
(favorite stops). Findings ranked SV-1..SV-8; no changes made.

## How it works today

Three sections: **Places** (search-to-add; cards with icon-picker button,
"Home"/"saved place" subtitle, ✕-with-confirm), **Stops** (search-to-add;
cards whose head opens the full schedule sheet and whose body shows a live
line-grouped board), **Pinned departures** (starred individual runs, live
re-matched by tripId, auto-purged 24h after departure). Home = choosing the
house icon in the icon picker (exclusive); Home sorts first. Caps: 12 stops,
20 places — oldest silently evicted.

## What is already strong — keep

- **Favorite stops with live grouped boards** is Transit's signature feature
  and ours is at parity: compound kind labels, next-runs stacking, tap-through
  to the full day schedule. This is the best thing on the tab.
- **Pinned departures** (pin ONE run, live-refreshed, self-purging) is
  something none of the benchmark apps offer cleanly.
- Honest empty states; remove actions confirm; adds are one tap with a toast.

## Findings

**SV-1 · P1 — Saved places DO nothing when tapped.** The card's only actions
are change-icon and remove. In every benchmark a saved place's primary tap
routes you there (Citymapper's whole pitch is one-tap "Get me home"; Google
taps into directions). The app already has destination-first routing — the
Home-tab quick-picks use it — so the natural fix is: tap a place card → jump
to Home with From="My location", To=the place, search running. Highest-value
change on the tab; the card body is currently dead space.

**SV-2 · P1 — Home is nearly undiscoverable.** Setting Home means knowing to
tap the little icon button, then knowing that picking the house icon IS the
designation. Nothing on a place card offers "Make this Home"; the empty state
mentions Home but the add-flow never does. Google/Citymapper treat Home (and
Work) as permanent labelled slots that ask to be filled. Suggest: when no Home
exists, a persistent "Set Home" slot row at the top of Places; and an explicit
"Set as Home" row in the icon-picker sheet (the icon-as-designation coupling
is clever but silent).

**SV-3 · P2 — 230px of add-chrome before any content.** Title + header + an
84px search card, twice. The benchmarks put content first and adding behind a
compact "+ Add" affordance. Suggest: slim "+ Add a place" / "+ Add a stop"
rows that expand into the search input on tap — reclaims ~120px and puts
saved things above the fold.

**SV-4 · P2 — Silent eviction at the caps.** Adding a 13th stop or 21st place
silently deletes the oldest (store slice). A user who saved 12 stops loses one
with no signal. At minimum toast "Oldest removed — 12 max"; better, block with
"remove one first" (the caps exist for card-fetch cost, which is fair).

**SV-5 · P2 — Work exists as an icon but not as a concept.** The icon set has
place-work.svg, but Work neither sorts high nor gets a slot. If Home gets
SV-2's slot treatment, Work should ride along (Google/Citymapper pair them).

**SV-6 · P3 — Stop-card subtitle truncates.** "train, tram & bus station ·
tap for tod…" — the hint loses to the kind label on one line. Either drop the
hint (the chevronless head is already tappable; SV-1's convention teaches
taps) or move it to a second line.

**SV-7 · P3 — No reordering.** Order is Home-first then add-recency. Fine at
this scale; benchmarks offer drag-reorder inside lists. Note-only.

**SV-8 · P3 — No travel-time glance on places.** Google shows "23 min" to
Home/Work from where you stand. Would cost a routing call per place per view —
only worth it behind a visible-tab-only fetch, and only for Home. Optional.

## Suggested order if taken

SV-1 (tap = route there) → SV-2 + SV-5 (Home/Work slots + explicit set-as-Home)
→ SV-3 (compact add rows) → SV-4 (eviction honesty) → SV-6 → SV-7/8 as taste.
