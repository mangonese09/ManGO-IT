# Matrix intro draft — #transitous:matrix.spline.de

Post as-is or trim. Repo is public, so every claim links.

---

Hi! I'm the author of ManGO:IT (https://it.mangonese.dev), a small non-commercial
PWA for getting around Sicily by public transport, and of PR #2327 which adds two
Sicily sources to feeds/it.json — wanted to introduce the project here as the
usage policy suggests.

**What it is:** Sicily's ~40 intercity coach operators only published timetables
as PDFs on a regional portal, so I built a pipeline (PDF → GTFS, deterministic
parsing with semantic validation gates) and the PR submits the resulting feed
(CC-BY 4.0, attribution to Regione Siciliana + operators) plus FCE Circumetnea's
own official GTFS. Source, provenance manifests, and QA reports are all public:
https://github.com/mangonese09/ManGO-IT

**API usage:** single-user app today. The proxy tracks per-day upstream request
counts (visible at https://it.mangonese.dev/api/health) — currently on the order
of a few hundred requests/day total across geocode/plan/stoptimes, cached
60s–24h server-side. UA is `ManGO-IT/x.y (+https://it.mangonese.dev; …)`.
Attribution to Transitous + sources + OSM is in the app's Settings screen.

**Degradation:** the app has its own direct-service fallback from the same GTFS
data, so your instance isn't its only path when things are down — traffic
shouldn't spike against you during incidents either.

Happy to adjust the feed (naming, licensing declaration, shape) to fit project
conventions, and to maintain the Sicily sources going forward. Feedback welcome
on #2327!
