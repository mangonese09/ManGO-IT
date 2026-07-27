# Capacitor Android wrap — design exercise (M7 / audit 1D, 2026-07-27)

Design only — no code exists yet (inventory §6). Decisions below follow the
ManGO classic wrap (v8.34.x era), which is the working precedent on this
phone.

## Why wrap at all

- Home-screen presence without PWA-install friction (the WebAPK icon saga
  proved how fragile that path is on this device).
- Native Android back handling instead of the JS nav-stack heuristics.
- Future: widgets (next-departure tile), notifications (departure alarm).

## Shape

Mirror the ManGO classic setup — one Capacitor project wrapping the LIVE
site (server URL mode, `https://it.mangonese.dev`), not a bundled copy:

- **Server-URL wrap, not bundled assets.** The PWA already deploys many
  times a day; bundling would reintroduce an APK release train for every
  UI change. Capacitor's `server.url` keeps the app always-current, and
  the SW keeps it offline-capable. APK rebuilds only when native bits
  change.
- **Back button**: `App.addListener('backButton')` → call the existing
  `popNav()` (same contract the left-edge swipe uses); exit app only from
  the home view with an empty stack.
- **Status bar**: dark `#141414` to match `theme_color`; no notch overlap
  (viewport-fit already handled in CSS).
- **Install-prompt retirement**: when running inside Capacitor
  (`window.Capacitor` present), hide any "install this app" affordances
  and the SW update toast cadence stays as-is (updates arrive from the
  server naturally).
- **Geolocation**: keep using the web API (works in the WebView with the
  standard permission); the Capacitor Geolocation plugin only if the web
  path proves flaky on-device.
- **Icon**: reuse `icons/icon-512.png` (opaque, edge-to-edge) as adaptive
  foreground+background per the no-padding icon rule.

## Deliberately NOT in v1 of the wrap

- Widgets (needs a native next-departure endpoint contract first — design
  after PR #2327 changes what "next departure" means).
- Push notifications (no server push infra; departure alarms would be
  local notifications — separate feature with its own UX).
- Play Store distribution (sideloaded debug APK like the other apps).

## Build checklist (when green-lit)

1. `npm i @capacitor/core @capacitor/cli @capacitor/android` (dev-only —
   keep the zero-dep runtime promise for the site itself).
2. `npx cap init "ManGO:IT" dev.mangonese.mangoit --web-dir=www` with a
   stub `www/` (server-URL mode ignores it).
3. `capacitor.config.json`: `server.url = https://it.mangonese.dev`,
   `backgroundColor #141414`, `androidScheme https`.
4. Back-button bridge + `Capacitor` detection in `js/app.js` (5 lines).
5. Adaptive icon from icon-512; `ManGO-IT-vX.Y.Z-debug.apk` to repo root,
   user sideloads (same flow as ManGO classic).

Estimated effort: one short session; risk is entirely in device QA.
