# Phase 2 — Competitive teardown: Google Maps transit & Transit

Concrete mechanics only, each with a steal / adapt / reject verdict against
our constraints: scheduled-heavy regional feed (real-time only on Trenitalia
legs), one region, vanilla-JS PWA, bad-cellular-first.

## 1. Itinerary at a glance (result card)

**Google Maps:** one line per itinerary — departure→arrival clock pair left,
total duration right, beneath it a compact leg strip: mode glyph + route
badge + chevron per leg, walking legs collapsed into the chevrons unless
long. Fare and "in X min" only when known. Detail (per-stop lists, alerts)
is one tap down.
**Transit:** ETA-first — the dominant element is a huge countdown to the
next feasible departure, in the line's brand color; the itinerary is
secondary to "your bus comes in 6 minutes."

**Verdict — adapt (Google's card, not Transit's countdown-first):** our
users plan intercity trips hours ahead on sparse schedules; countdown-first
is for 8-minute-headway metros. Card = `dep–arr` clocks dominant + duration,
leg strip with mode glyph + operator-colored route badge, walks collapsed.
Transfer count + tightest transfer buffer surfaced on the card (see §4).

## 2. Time encoding

**Google:** absolute clocks dominate intercity results ("14:05–16:50");
relative time ("leaves in 12 min") only for imminent departures.
**Transit:** relative countdown dominates; absolute clock is the small text.

**Verdict — steal Google's rule with Transit's threshold:** absolute clocks
always; add a relative "in 25 min" chip only when departure < 60 min away.
Sparse rural schedules make missed absolute times catastrophic (next coach:
tomorrow), so clocks lead.

## 3. Real-time vs scheduled, side by side

**Transit:** two pulsating waves beside a countdown = live GPS; absence =
schedule. One glyph, learnable, no text.
**Google:** green/red "delayed/on time" tints on the clock, small "live"
badge; scheduled legs just show plain clocks next to live ones.

**Verdict — steal Transit's pulse glyph** (we already have `is-live` green
chips; upgrade to an animated pulse) and keep our staleness stamps. Rule
stays binary and honest: pulse = ViaggiaTreno/GTFS-RT-backed, plain =
scheduled, grey + age = cached-stale. Never tint a scheduled time green.

## 4. Transfer risk

**Google:** shows transfer duration in the detail ("8 min to change"), no
risk grading on the card.
**Transit:** GO mode warns in-trip ("your connection is in 5 min") but the
card doesn't grade risk either.

**Verdict — improve on both (neither is good enough for Sicily):** coaches
are hourly-or-worse, so a blown 5-min transfer strands people. Card shows
the *worst* transfer buffer with a three-tier chip (≥15 min calm / 6–14 min
tight / ≤5 min risky), and ferry transfers get their own stricter tiers when
ferries land (a missed hydrofoil = stranded overnight).

## 5. No-good-route behavior — the pattern to steal hardest

**Google:** never a bare empty state: it shifts the time window ("next
departure tomorrow 06:10" with date), offers route-option toggles (fewest
transfers / less walking), and falls back to mixed modes (drive-to-station).
**Transit:** when no itinerary exists it still shows nearby lines and their
next departures — the user always sees *something real* about the network.

**Verdict — steal both, they're complementary and match the brief's
no-results rule:** (a) auto-retry the plan at +1 day and present "no service
today — first run Mon 06:15" with the date; (b) when MOTIS returns nothing,
render `/api/direct` single-leg results inline (labeled "direct coaches
we know about"); (c) when both are empty, show nearest served towns with
distances (we have every stop's coords), and name the coverage gap plainly.
Each dead end must emit one of these, tested in Playwright.

## 6. Nearby departures board

**Transit:** ranks by (distance-weighted) next-departure imminence, not pure
distance; collapses multiple directions of one line into a single row with
two countdowns; truncates hard (top ~8 lines) behind "show more."
**Google:** station-centric; you pick a station first, then see its board.

**Verdict — steal Transit's ranking:** our board is pure nearest-5-stops;
switch to line-first rows ranked by soonest departure, both directions on
one row, hard truncation. Station-first (Google) rejected — wrong for a
region where the "station" is often one pole on a road.

## 7. Mode color coding

**Transit:** line brand colors everywhere; degrades to mode-default hues
when an operator has no color. **Google:** mode glyph + agency color chip,
grey default.

**Verdict — adapt:** five fixed mode colors (regional rail / intercity
coach / urban bus / metro-tram / ferry) from the Sicily accent palette,
colorblind-checked, each with a distinct glyph (we already ship distinct
glyphs since v0.5.1). Operator brand colors rejected: 44+ tiny operators,
no reliable brand data, and consistency beats identity at our scale.

## 8. Platform/bay codes

**Transit (2025):** platform code chip on the ETA card when the feed has it.
**Verdict — steal when available:** Trenitalia binario via ViaggiaTreno is
already fetched (track field in stoptimes); surface it as a chip in detail
view. Coach bays mostly don't exist in our data — never invent one.

## Summary of steals (feeds Phase 4 backlog)

1. Dead-end triple fallback (next-day probe / direct-leg inline / nearest
   served town) — highest impact, direct hit on the #1 complaint.
2. Google-style result card with dominant clock pair + leg strip.
3. Worst-transfer-buffer chip with three risk tiers (our own extension).
4. Transit-style live pulse glyph; scheduled/cached visual honesty kept.
5. Line-first nearby board ranked by imminence with two-direction rows.
6. Fixed mode palette + glyphs; binario chip on rail detail.

Sources: Transit blog (Transit 6.0 design language), Transit help center
(GO, real-time indicators), Google Maps transit route options / Routes API
transit docs, howtogeek/popsci feature walkthroughs (2025).
