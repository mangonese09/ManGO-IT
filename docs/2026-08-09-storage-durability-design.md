# Storage durability & update methodology

**Date:** 2026-08-09
**Status:** approved, awaiting implementation plan
**Motivation:** harden local persistence *before* Google/anonymous auth lands. Pre-emptive — no data loss has been observed.

## Problem

All user data (`favstops`, `places`, `recents`, `saved`, `settings`) lives in `localStorage` under the `mangoit.` prefix. The update path does **not** touch it: `checkForUpdates` (`js/settings.js:148`) reloads on `controllerchange`, and the service worker's `activate` (`service-worker.js:77`) deletes only stale *caches*. Only the explicit "Clear cached data" button (`js/settings.js:46`) clears user data.

So updates are safe today. What is *not* safe is everything around them:

1. **No schema versioning.** `read()` returns the fallback on any JSON parse error, so a shape change or a half-written value reads as "no favorites" with zero signal. Ad-hoc legacy patching already exists in the wild: `js/saved.js:589` does `s.iconMode || (s.icon === '🚌' ? 'COACH' : 'BUS')`.
2. **API cache shares the user-data bucket.** `cache.*` blobs sit in the same ~5MB origin quota as `favstops`/`places`, pruned only by a 48h age rule, and `write()` (`js/store.js:15`) silently swallows quota errors — a favorite can fail to save with no error, which reads to the user as "it got cleared".
3. **No persistence request, no backup.** `navigator.storage.persist()` is never called, and nothing can export or restore state.
4. **Four keys bypass `store.js`,** each with its own silent `try/catch`: `mangoit.view` (`js/app.js:21`), `mangoit.mapStyle` / `mangoit.mapModes` (`js/mapview.js:88,991`), `mangoit.modes` (`js/search.js:211`). Any migration or backup living in `store.js` would miss all four.

Auth is the trigger: the anonymous → Google sign-in upgrade is the single most likely moment to destroy someone's data, and anonymous users have no cloud copy at all. The local layer must be versioned and restorable *first*.

## Design

### 1. `store.js` is the only door to localStorage

Every key moves behind `store.js`, including the four strays. One place owns reads, writes, versioning, backup, and quota policy. This is the seam auth plugs into: Firestore mirrors *this* shape and nothing else needs to know.

### 2. Versioned schema with an explicit migration chain

```js
const SCHEMA_VERSION = 2;   // 1 = today's unversioned shape
```

`migrateStorage()` runs on boot: read `mangoit.schemaVersion` (absent ⇒ 1), run migrations in order. Before the first migration runs, snapshot every user key to `mangoit.__backup.v1`. If a migration throws, the next boot restores from that snapshot rather than proceeding on half-migrated data.

Migration 1→2 codifies the currently-inline legacy patch: `favstops` entries with an emoji `icon` and no `iconMode` get `iconMode` filled. The fallback at `js/saved.js:589` is then deleted — the migration owns it, one source of truth instead of two.

### 3. Unreadable data is quarantined, never dropped

A user-data key that will not parse has its raw bytes moved to `mangoit.__quarantine.<key>.<ts>` before the fallback is returned. Cache keys still drop silently; they are disposable.

Signal is deliberately quiet: Settings → Data grows a "N recovered backups available" line rather than an interrupting modal. (Judgment call — escalate to a one-time notice if quiet proves too quiet.)

### 4. Quota: user data wins over cache

On a quota failure writing user data, evict `cache.*` entries and retry once. If it still fails, surface a toast and return `false` so the caller knows. API responses can never crowd out saved stops.

### 5. Persistent storage + honest readout

`navigator.storage.persist()` once on boot, non-blocking. Settings → Data reports the true state ("Protected" / "Best-effort") rather than claiming a guarantee the browser did not give.

### 6. Backup: export / import

Settings → "Back up my data" writes `mango-it-backup-YYYY-MM-DD.json`:

```json
{ "app": "mangoit", "schemaVersion": 2, "exportedAt": "…", "data": { "favstops": [], "places": [], "…": [] } }
```

Import: file picker → migrate if older → styled confirm naming exactly what lands ("12 saved stops, 4 places, 6 recent searches — this replaces what's on this device") → write → reload. No native dialogs, per standing preference.

**Caveat:** blob downloads are unreliable inside the Capacitor WebView. Falls back to copy-to-clipboard. Verify which path actually fires in the APK rather than assuming.

### 7. Proof: `tests/review/session-update.js`

Existing session tests run against live prod, which cannot stage a version bump. This one serves a temp copy of the working tree from a throwaway static server so the test controls the version, and chains five sessions:

| Session | Asserts |
|---|---|
| S1 | seed favorites + places + recents at version A, assert stored |
| S2 | bump copy to version B (`version.json`, SW `CACHE`, `?v=` strings), tap Check for updates, ride the real `controllerchange` → reload, assert version B **and** every item still present |
| S3 | plant a v1-shaped favstop → assert migrated and rendering correctly |
| S4 | plant corrupt JSON → assert quarantined, not silently empty |
| S5 | export → clear all → import → assert full round trip |

S2 is the regression that directly answers "can an update clear my history?", and it runs on every deploy from then on.

## Out of scope

Firestore, auth, cloud sync. Those build on this layer once it is versioned and restorable.
