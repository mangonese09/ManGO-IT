# QA Phase 0 — Screen & Interactive Element Inventory (v0.9.2)

## Screens / states

| # | Screen | States |
|---|---|---|
| 1 | Home / search | cold (empty fields), suggesting (dropdown open), My-location row, loading (mango spinner), results (itinerary cards), results+direct block, results+faster-coach block, dead-end (empty-state + next-day probe + nearest-served + horizon note), horizon note under results |
| 2 | Home / nearby board | loading, no-location empty state, line-first rows (+Show more), network-error state |
| 3 | Saved | empty, favorite-stop cards (loading rows, populated, error), saved-departure rows (live/cancelled/stale), stop-search suggesting |
| 4 | Map | no-location empty, stop list populated, load error |
| 5 | Settings | populated (theme toggle, update check, freshness, attributions) |
| 6 | Trip detail sheet | plan itinerary variant, direct-coach variant, chain variant (walk in/out rows) |
| 7 | Full-schedule sheet | loading, coach all-day, live-network 40-dep, empty, error |
| 8 | Confirm modal | remove-favorite |
| 9 | Toasts | info / warn, stacking behavior |

## Interactive elements (DOM-extracted at 390px, home cold + results)

| Screen | Element | Notes |
|---|---|---|
| chrome | 4 nav buttons (#nav-home/saved/map/settings) | img icons |
| Home | #from-input, #to-input | text inputs |
| Home | #from-clear, #to-clear | conditional ✕ |
| Home | #swap-btn | hidden while suggesting (v0.9.2) |
| Home | #when-toggle, #when-input | depart/arrive + datetime-local |
| Home | #mode-train, #mode-bus | filter chips |
| Home | #search-btn | primary |
| Home | .suggest-row ×n (from/to) | incl. My-location |
| Home | .chip-recent ×≤4 | recents |
| Home | .iti-card ×n | opens sheet |
| Home | .dep-row-btn ×n | direct rows, opens sheet |
| Home | dead-end "Search that day instead" btn | conditional |
| Home | nearest-served hint (text only) | not tappable (finding candidate) |
| Board | #board-refresh, .pin-btn per direction, Show-more btn | |
| Saved | #fav-input, .suggest-row, .fav-stop-tap (schedule), .pin-btn remove, saved-row pins | |
| Sheets | .sheet-close, .sheet-grab (drag), backdrop | Escape? (tested in Phase 2) |
| Settings | theme toggle, update check | |

## Harness

- `qa/scripts/sweep.mjs` — Phase 1 battery × 6 viewports × 2 themes (+130%/200% text): overflow, dead space, alignment clusters, touch targets, WCAG contrast, nav collision, CLS on results, token harvest (base).
- `qa/scripts/interact.mjs` — Phase 2 battery (tap spam, toggle spam mid-flight, XSS/RTL/600-char input, same-O/D, Enter key, sheet dismissal ×4 paths, toast stacking, browser-back ×6, mid-search refresh).
- `qa/scripts/datastress.mjs` — Phase 3 real-data stress (long Sicilian names, multi-leg, overnight, zero-results, degraded labeling, offline-warm).
- All run against the LIVE site by default; pass a URL for local. No mocks, no internal-state assertions.
