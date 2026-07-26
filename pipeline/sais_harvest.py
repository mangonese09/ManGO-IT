# ── SAIS AUTOLINEE (Albatross API) ──
# saisautolinee.it runs an unauthenticated Albatross v8.3 timetable API
# (recon: docs/sais-recon.md). No PDFs, no geocoding: /stops carries exact
# lat/lon, /routestimetables/timetable carries per-stop times AND exact
# validity calendars (validityFrom/To + weekday flags + exceptions) — so
# these services skip the school-year approximation entirely and are
# emitted as explicit date lists.
#
# IMPORTANT (verified 2026-07-25): the ?date= param FILTERS templates to
# those active on that exact date (Mon fetch ≠ Sun fetch, 14/36 shared).
# One date is NOT enough; we sweep full weeks across the timetable period
# so every weekday×period combination is observed at least once. Validities
# are complete per template, so merging by templateId reconstructs the
# whole calendar. All 19 national lines are dismissed in /lines — the API
# is Sicily-internal only.
#
# Outputs (same contract assemble.py produces, so emit → validate pick
# them up unchanged):
#   data/routes/sais-*.json          route JSONs, service carries explicit_dates
#   data/sais-stop-coords.json       name → {lat, lon, precision:'exact'}
#   data/sais/                       raw API cache + sha256 manifest
#
# Politeness: 1 req/s, batched lineIds (~140 requests/full sweep), our UA.
# Refresh weekly — validities currently end 2026-09-13 (summer period);
# the winter period appears in the API later and a re-run picks it up.
import hashlib, json, os, re, sys, time, urllib.request
from datetime import date, timedelta

ROOT = os.path.dirname(__file__)
SAIS_DIR = os.path.join(ROOT, 'data', 'sais')
ROUTES = os.path.join(ROOT, 'data', 'routes')
COORDS_F = os.path.join(ROOT, 'data', 'sais-stop-coords.json')

BASE = 'https://api.saisautolinee.it'
UA = 'ManGO-IT/0.5.0 (+https://it.mangonese.dev; miconsig@gmail.com)'
OPERATOR = 'SAIS Autolinee'
BATCH = 20          # lineIds per timetable request
DELAY = 1.0         # seconds between requests

# Sweep weeks: one full week inside each plausible sub-period of the
# timetable horizon, computed from today so the weekly refresh keeps
# working (0/2/5/7/9 weeks out from next Monday ≈ 10 weeks of horizon;
# far-out weeks past the loaded period return 2-byte empties, cheap).
_ANCHOR = date.today() + timedelta(days=(7 - date.today().weekday()) % 7 or 7)
SWEEP_WEEKS = [_ANCHOR + timedelta(weeks=w) for w in (0, 2, 5, 7, 9)]
SWEEP_DATES = [w + timedelta(days=i) for w in SWEEP_WEEKS for i in range(7)]

# Italian national holidays relevant to observed validity windows
# (validities currently end Sept 2026; keep a superset for safety).
HOLIDAYS = {
    date(2026, 8, 15), date(2026, 11, 1), date(2026, 12, 8),
    date(2026, 12, 25), date(2026, 12, 26),
    date(2027, 1, 1), date(2027, 1, 6),
    date(2027, 3, 28), date(2027, 3, 29),
    date(2027, 4, 25), date(2027, 5, 1), date(2027, 6, 2),
}

DOW = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

# Same bbox validate.py enforces. /stops carries mainland berths (for the
# dismissed national lines) AND at least one corrupt coordinate (Augusta
# 'Via Marconi incr. Via Malta' at lat 4.69): out-of-bbox stops are treated
# as coordinate-less and dropped from trip sequences, never shipped.
SICILY = dict(latMin=36.5, latMax=38.9, lonMin=11.9, lonMax=15.8)


def in_sicily(s):
    lat, lon = s.get('latitude') or 0, s.get('longitude') or 0
    return SICILY['latMin'] <= lat <= SICILY['latMax'] and SICILY['lonMin'] <= lon <= SICILY['lonMax']


def fetch(path, cache_name, manifest, force=False):
    """GET → cached JSON file under data/sais/ with sha256 in the manifest."""
    fp = os.path.join(SAIS_DIR, cache_name)
    if os.path.exists(fp) and not force:
        return json.load(open(fp, encoding='utf-8'))
    req = urllib.request.Request(BASE + path, headers={'User-Agent': UA})
    time.sleep(DELAY)
    raw = urllib.request.urlopen(req, timeout=60).read()
    data = json.loads(raw)
    os.makedirs(SAIS_DIR, exist_ok=True)
    with open(fp, 'wb') as f:
        f.write(raw)
    manifest[cache_name] = {'url': BASE + path, 'sha256': hashlib.sha256(raw).hexdigest(),
                            'bytes': len(raw), 'fetched': date.today().isoformat()}
    return data


def d_of(obj):
    return date(obj['year'], obj['month'], obj['day'])


# Some validities are open-ended (validityTo decades out, ~200 years of
# dates = a 490MB coach-trips.json); clamp to the window the feed ships.
WINDOW_LO = date.today()
WINDOW_HI = date(2027, 7, 31)  # emit_gtfs FEED_END


def validity_dates(validities, unknown_freqs):
    """Explicit running dates from Albatross validities, clamped to
    [WINDOW_LO, WINDOW_HI]. daysOfWeek flags gate weekdays; exceptions[]
    subtract dates; nationalHolidays=true additionally admits holidays
    (festivo semantics); excludeNationalHolidays=true subtracts them."""
    out = set()
    for v in validities:
        f = v['frequency']
        if f.get('type', 0) != 0 or f.get('step', 0) not in (0, 1):
            unknown_freqs.append(f)
            continue
        lo = max(d_of(v['validityFrom']), WINDOW_LO)
        hi = min(d_of(v['validityTo']), WINDOW_HI)
        exc = {d_of(e) for e in v.get('exceptions', [])}
        d = lo
        while d <= hi:
            run = f['daysOfWeek'][DOW[d.weekday()]]
            if f.get('nationalHolidays') and d in HOLIDAYS:
                run = True
            if f.get('excludeNationalHolidays') and d in HOLIDAYS:
                run = False
            if run and d not in exc:
                out.add(d)
            d += timedelta(days=1)
    return out


def stop_name(s):
    city = re.sub(r'\s+', ' ', (s.get('shortDescription') or '').strip())
    addr = re.sub(r'\s+', ' ', (s.get('address') or '').strip())
    if addr and addr.upper() != city.upper():
        return f'{city.upper()} ({addr})'
    return city.upper()


def _hav_m(a, b):
    import math
    p = math.pi / 180
    return 2 * 6371000 * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2 +
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def build_name_map(stops):
    """stopId → display name, deterministic. /stops registers some berths
    twice under the same city+address (usually <35m apart, e.g. one entry
    per sales system): same-named stops within 400m collapse to ONE name
    (they're the same stop for a rider); genuinely distinct same-named
    stops (only GELA Via Cortemaggiore, ~1km) get an [externalId] suffix.
    sais_verify.py imports this so both sides always name stops alike."""
    groups = {}
    for s in stops:
        groups.setdefault(stop_name(s), []).append(s)
    out = {}
    for nm, group in groups.items():
        if len(group) == 1:
            out[group[0]['id']] = nm
            continue
        group.sort(key=lambda s: (s.get('externalId') or '', s['id']))
        spread = max(_hav_m((a['latitude'], a['longitude']), (b['latitude'], b['longitude']))
                     for i, a in enumerate(group) for b in group[i + 1:])
        for i, s in enumerate(group):
            if spread <= 400 or i == 0:
                out[s['id']] = nm
            else:
                out[s['id']] = f"{nm} [{s.get('externalId') or s['id'][:8]}]"
    return out


def hmm(stop_time):
    h = stop_time['days'] * 24 + stop_time['hours']
    return f"{h}.{stop_time['minutes']:02d}"


def rid_of(line, taken):
    code = re.sub(r'[^a-z0-9]+', '-', str(line['code']).lower()).strip('-')
    rid = f'sais-{code}'
    if rid in taken:  # urban pools reuse small codes (Enna '1' vs Siracusa '1')
        grp = re.sub(r'^linee\s+(urbane\s+)?', '', (line.get('statGroup') or 'x').strip().lower())
        grp = re.sub(r'[^a-z0-9]+', '-', grp).strip('-')[:20]
        rid = f'sais-{grp}-{code}'
    n, base = 2, rid
    while rid in taken:
        rid = f'{base}-{n}'; n += 1
    taken.add(rid)
    return rid


def main():
    force = '--refetch' in sys.argv
    os.makedirs(SAIS_DIR, exist_ok=True)
    man_f = os.path.join(SAIS_DIR, 'manifest.json')
    manifest = json.load(open(man_f, encoding='utf-8')) if os.path.exists(man_f) else {}
    if force:  # clean slate: stale sweep-date caches would never be read again
        for f in os.listdir(SAIS_DIR):
            if f.startswith('tt-'):
                os.remove(os.path.join(SAIS_DIR, f))
        manifest = {k: v for k, v in manifest.items() if not k.startswith('tt-')}

    stops = fetch('/stops', 'stops.json', manifest, force)
    lines = fetch('/lines', 'lines.json', manifest, force)
    active = [l for l in lines if not l['dismissed']]
    print(f'{len(lines)} lines ({len(active)} active), {len(stops)} stops')

    # ── stop name map + coords sidecar (exact coords, no geocoding) ──
    by_id = {s['id']: s for s in stops}
    name_of = build_name_map(stops)

    # ── sweep timetables ──
    batches = [active[i:i + BATCH] for i in range(0, len(active), BATCH)]
    templates = {}   # (lineId, routeCode, templateId) → template dict
    route_meta = {}  # (lineId, routeCode) → {description, direction}
    n_req = n_empty = 0
    for d in SWEEP_DATES:
        for bi, batch in enumerate(batches):
            ids = ','.join(l['id'] for l in batch)
            cache_name = f'tt-{d.isoformat()}-b{bi}.json'
            data = fetch(f'/routestimetables/timetable?lineIds={ids}&date={d.year}-{d.month}-{d.day}',
                         cache_name, manifest, force)
            n_req += 1
            if not data:
                n_empty += 1
                continue
            for route in data:
                rk = (route['lineId'], route['routeCode'])
                route_meta[rk] = {'description': route.get('description', ''),
                                  'direction': route.get('direction', 0)}
                for t in route['tripTemplates']:
                    templates.setdefault(rk + (t['templateId'],), t)
        json.dump(manifest, open(man_f, 'w', encoding='utf-8'), indent=1)
    print(f'sweep: {len(SWEEP_DATES)} dates × {len(batches)} batches = {n_req} responses ({n_empty} empty)')
    print(f'{len(route_meta)} route variants, {len(templates)} unique trip templates')

    # ── route JSONs ──
    for f in os.listdir(ROUTES):
        if f.startswith('sais-'):
            os.remove(os.path.join(ROUTES, f))

    unknown_freqs, no_dates, short_trips = [], 0, 0
    bad_coord_drops = [0, 0]  # [unknown stopId, out-of-bbox coord]
    merged_trips = 0
    used_stop_ids = set()
    taken, written, n_trips = set(), 0, 0
    for line in active:
        line_tpls = {k: v for k, v in templates.items() if k[0] == line['id']}
        if not line_tpls:
            continue
        rid = rid_of(line, taken)
        dirs = {}   # direction → {'stops': [...], 'trips': [...], '_seen': set()}
        for (lid, rcode, tid), t in sorted(line_tpls.items(), key=lambda kv: (kv[0][1], kv[0][2])):
            meta = route_meta[(lid, rcode)]
            di = 1 if meta['direction'] else 0
            dates = validity_dates(t['validities'], unknown_freqs)
            if not dates:
                no_dates += 1
                continue
            seq = []
            for i, s in enumerate(t['stops']):
                sid = s['stopId']
                if sid not in by_id or not in_sicily(by_id[sid]):
                    bad_coord_drops[0 if sid not in by_id else 1] += 1
                    continue
                used_stop_ids.add(sid)
                tm = hmm(s['stopTime'])
                seq.append({'stop': name_of[sid], 'idx': i, 'arr': tm, 'dep': tm})
            if len(seq) < 2:
                short_trips += 1
                continue
            mins = [int(x['arr'].split('.')[0]) * 60 + int(x['arr'].split('.')[1]) for x in seq]
            dd = dirs.setdefault(di, {'stops': [], '_seen': set(), '_sigs': {}, 'trips': []})
            # Albatross often carries several templates with IDENTICAL times but
            # different validity windows (summer vs autumn slices of the same
            # run): merge by unioning dates instead of letting emit's
            # duplicate-signature gate silently drop the later window.
            sig = tuple((x['stop'], x['arr']) for x in seq)
            new_dates = sorted(x.isoformat() for x in dates)
            if sig in dd['_sigs']:
                svc = dd['_sigs'][sig]['service']
                svc['explicit_dates'] = sorted(set(svc['explicit_dates']) | set(new_dates))
                svc['raw'] = f"{len(svc['explicit_dates'])} exact dates (merged templates)"
                merged_trips += 1
                continue
            for x in seq:
                if x['stop'] not in dd['_seen']:
                    dd['_seen'].add(x['stop']); dd['stops'].append(x['stop'])
            trip = {
                'corsa': t.get('dailyCode') or tid[:8],
                'service': {'days': 'explicit', 'school': None, 'season': None,
                            'raw': f'{len(dates)} exact dates from Albatross validities',
                            'explicit_dates': new_dates},
                'reverse': di == 1,
                'variant': meta['description'],
                'stops': seq,
                'valid': all(a <= b for a, b in zip(mins, mins[1:])),
            }
            dd['_sigs'][sig] = trip
            dd['trips'].append(trip)
            n_trips += 1
        if not dirs:
            continue
        route = {'operator': OPERATOR, 'route_id': rid,
                 'name': re.sub(r'\s+', ' ', line['description'].strip()),
                 'short_name': str(line['code']),
                 'coords': 'external',  # geocode.py must skip: coords come from the API
                 'source': f"api.saisautolinee.it line {line['id']}",
                 'prescriptions': [], 'directions': []}
        for di in sorted(dirs):
            dirs[di].pop('_seen'); dirs[di].pop('_sigs')
            route['directions'].append(dirs[di])
        json.dump(route, open(os.path.join(ROUTES, f'{rid}.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        written += 1

    coords = {re.sub(r'\s+', ' ', name_of[sid].upper().strip()):
              {'lat': by_id[sid]['latitude'], 'lon': by_id[sid]['longitude'], 'precision': 'exact'}
              for sid in used_stop_ids}
    json.dump(coords, open(COORDS_F, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    print(f'{written} route JSONs, {n_trips} trips ({merged_trips} same-times templates merged), '
          f'{len(coords)} stops with exact coords')
    if any(bad_coord_drops):
        print(f'NOTE: dropped stop refs — {bad_coord_drops[0]} unknown stopId, '
              f'{bad_coord_drops[1]} outside Sicily bbox (bad/mainland coords)')
    if no_dates:
        print(f'NOTE: {no_dates} templates produced zero dates (expired/holiday-only outside window)')
    if short_trips:
        print(f'NOTE: {short_trips} templates dropped (<2 resolvable stops)')
    if unknown_freqs:
        print(f'ERROR: {len(unknown_freqs)} validities with UNKNOWN frequency type/step — NOT emitted:')
        for f_ in unknown_freqs[:5]:
            print('  ', f_)
        sys.exit(1)


if __name__ == '__main__':
    main()
