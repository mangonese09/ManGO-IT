# ManGO:IT

Sicily intercity transit in one view — regional rail, intercity coaches, and urban
networks across every operator, routed A→B with live train status. Built for use
on the ground, mid-trip, on a phone.

## Tech stack

- Vanilla HTML/JS PWA, no build step. Brand tokens from `mangonese.dev/shared/mangonese.css`.
- Node zero-dependency proxy (`server/proxy.js`) → [Transitous](https://api.transitous.org) (routing) + ViaggiaTreno (live trains).
- Storage: localStorage behind an adapter (`js/store.js`). Firebase Auth + Firestore mirror is a planned fast-follow (single-user v1 doesn't need sync yet).
- Hosting: VPS nginx at `it.mangonese.dev`, proxy under pm2.

## Run locally

```
STATIC=1 node server/proxy.js     # serves app + API on http://localhost:3041
npm test                          # unit tests (node --test)
```

## Env vars

None. No API keys anywhere — Transitous and ViaggiaTreno are keyless; the proxy
exists for CORS, caching, and response slimming.

## Deploy

1. Bump version in `package.json`, `version.json`, `js/version.js`, `?v=` tags in
   `index.html`, and `CACHE` in `service-worker.js` (version-sync tests enforce most of this).
2. `scp` changed files to `root@107.172.39.168:/var/www/mangoit/`
   (server changes: also `scp server/proxy.js` and `ssh root@… 'pm2 restart mangoit-proxy'`).
3. Verify: `curl -s https://it.mangonese.dev/api/health`

## Milestones

M0 repo/hosting ✅ · M1 routing+search ✅ · M2 nearby board+saved ✅ · M3 live
trains+staleness ✅ · M4 **coach GTFS pipeline** (the whole point) · M5 long-tail
operators · M6 map tab · M7 Capacitor Android wrap.

## Licensing & usage

Code: MIT. Generated GTFS feed: **CC-BY 4.0** with attribution to Regione
Siciliana and the source operators. The app never sells or books tickets
(hard non-goal) and is strictly non-commercial, per the
[Transitous usage policy](https://transitous.org/api/).

## PRD

[docs/prd.md](docs/prd.md) — locked before any code was written. §7 (coach PDF →
GTFS → Transitous pipeline) is the reason this app exists.
