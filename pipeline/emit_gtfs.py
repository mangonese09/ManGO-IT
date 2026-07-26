# ── STAGE 5: EMIT GTFS ──
# routes/*.json + stop-coords.json → sicily-coaches.gtfs.zip
#
# Calendars are emitted as explicit calendar_dates.txt additions (no
# calendar.txt weekday logic): every service's exact running dates are
# computed here, so feriale/festivo/scolastico/seasonal combinations stay
# unambiguous. Approximations (school year, holiday list) are documented in
# feed NOTES and kept in one place below.
import csv, io, json, os, re, unicodedata, zipfile
from datetime import date, timedelta

ROOT = os.path.dirname(__file__)
ROUTES = os.path.join(ROOT, 'data', 'routes')
OUT_DIR = os.path.join(ROOT, 'dist')

FEED_START = date(2026, 8, 1)
FEED_END = date(2027, 7, 31)
# Sicily school calendar (approximate; regional decree varies by ~a few days)
SCHOOL_START = date(2026, 9, 14)
SCHOOL_END = date(2027, 6, 8)
SCHOOL_BREAKS = [
    (date(2026, 12, 23), date(2027, 1, 6)),   # Christmas
    (date(2027, 3, 25), date(2027, 3, 30)),   # Easter
]
HOLIDAYS = {
    date(2026, 8, 15), date(2026, 11, 1), date(2026, 12, 8),
    date(2026, 12, 25), date(2026, 12, 26),
    date(2027, 1, 1), date(2027, 1, 6),
    date(2027, 3, 28), date(2027, 3, 29),
    date(2027, 4, 25), date(2027, 5, 1), date(2027, 6, 2),
}

AGENCY_URLS = {
    'Azienda Siciliana Trasporti': 'https://www.aziendasicilianatrasporti.it',
    'AST': 'https://www.aziendasicilianatrasporti.it',
    'Interbus': 'https://www.interbus.it',
    'Etna Trasporti': 'https://www.etnatrasporti.it',
    'SAIS Trasporti': 'https://www.saistrasporti.it',
    'SAIS Autolinee': 'https://www.saisautolinee.it',
}
FALLBACK_URL = 'https://pti.regione.sicilia.it'


def is_school_day(d):
    if not (SCHOOL_START <= d <= SCHOOL_END): return False
    if any(a <= d <= b for a, b in SCHOOL_BREAKS): return False
    if d in HOLIDAYS or d.weekday() == 6: return False
    return True


def season_window(season, d):
    if not season: return True
    def parse(s):
        dd, mm = s.split('/')
        return int(mm), int(dd)
    m0, d0 = parse(season['from']); m1, d1 = parse(season['to'])
    lo, hi = (m0, d0), (m1, d1)
    cur = (d.month, d.day)
    return lo <= cur <= hi if lo <= hi else (cur >= lo or cur <= hi)


def service_dates(svc):
    if svc.get('explicit_dates'):
        # SAIS/Albatross services carry their exact calendar (no school-year
        # or holiday approximation); just clip to the feed window.
        return [d for d in (date.fromisoformat(x) for x in svc['explicit_dates'])
                if FEED_START <= d <= FEED_END]
    days, school, season = svc['days'], svc['school'], svc['season']
    out = []
    d = FEED_START
    while d <= FEED_END:
        wd = d.weekday()
        run = False
        if days == 'daily':
            run = True
        elif days == 'sun-holidays':
            run = wd == 6 or d in HOLIDAYS
        elif days == 'mon-fri':
            run = wd <= 4 and d not in HOLIDAYS
        else:  # mon-sat feriale
            run = wd <= 5 and d not in HOLIDAYS
        if run and school == 'school-days-only' and days != 'sun-holidays':
            run = is_school_day(d)
        if run and school == 'school-days-only' and days == 'sun-holidays':
            run = SCHOOL_START <= d <= SCHOOL_END  # "domenicale nel periodo scolastico"
        if run and school == 'holidays-only':
            run = not (SCHOOL_START <= d <= SCHOOL_END) or not is_school_day(d)
        if run and not season_window(season, d):
            run = False
        if run: out.append(d)
        d += timedelta(days=1)
    return out


def slug(name):
    s = unicodedata.normalize('NFD', name)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return s[:60] or 'stop'


def svc_id(svc):
    if svc.get('explicit_dates'):
        import hashlib
        return 'x' + hashlib.sha1(','.join(svc['explicit_dates']).encode()).hexdigest()[:10]
    parts = [svc['days']]
    if svc['school']: parts.append(svc['school'])
    if svc['season']: parts.append(f"s{svc['season']['from'].replace('/', '')}-{svc['season']['to'].replace('/', '')}")
    return re.sub(r'[^a-z0-9\-]', '', '-'.join(parts))


def hms(t, wrapped_offset=0):
    h, m = re.split(r'[.:]', t)
    return f'{int(h) + wrapped_offset:02d}:{int(m):02d}:00'


JUNK_STOP = re.compile(r'^(Fermata( intermedia)?|Capolinea( di (Partenza|Arrivo))?)\s*$', re.I)


def hav_km(a, b):
    import math
    p = math.pi / 180
    return 2 * 6371 * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2 +
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def load_prescription_rules():
    try:
        return json.load(open(os.path.join(ROOT, 'prescription-rules.json'), encoding='utf-8'))['rules']
    except FileNotFoundError:
        return []


def main():
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    sais_f = os.path.join(ROOT, 'data', 'sais-stop-coords.json')
    if os.path.exists(sais_f):
        # API-exact coords win over geocoded pins for identically-named stops
        coords.update(json.load(open(sais_f, encoding='utf-8')))
    rules = load_prescription_rules()
    os.makedirs(OUT_DIR, exist_ok=True)

    agency_rows, route_rows, trip_rows, st_rows, cal_rows = [], [], [], [], []
    stop_rows, stops_seen, services_seen = [], {}, {}
    agencies_seen = {}
    skipped = []
    trip_sigs, trip_ids_seen = set(), set()

    for f in sorted(os.listdir(ROUTES)):
        route = json.load(open(os.path.join(ROUTES, f), encoding='utf-8'))
        op = route['operator']
        if op not in agencies_seen:
            aid = slug(op)[:24]
            agencies_seen[op] = aid
            agency_rows.append([aid, op, AGENCY_URLS.get(op, FALLBACK_URL), 'Europe/Rome', 'it'])
        aid = agencies_seen[op]
        rid = route['route_id']
        cod = re.search(r'cod\.?\s*(\d+)', route['name'], re.I)
        short = route.get('short_name') or (cod.group(1) if cod else '')
        route_rows.append([rid, aid, short, route['name'], 3])
        for di, d in enumerate(route['directions']):
            for t in d['trips']:
                if not t['valid']:
                    skipped.append((rid, t['corsa'], 'non-monotonic times')); continue
                svc = t['service']
                sid = svc_id(svc)
                if sid not in services_seen:
                    dates = service_dates(svc)
                    if not dates:
                        skipped.append((rid, t['corsa'], f'service {sid} has zero dates')); continue
                    services_seen[sid] = dates
                trip_id = f'{rid}-{di}-{t["corsa"]}'
                headsign = t['stops'][-1]['stop'].split('(')[0].strip().title()
                pending_st, pending_coords = [], []
                prev_min, offset = -1, 0
                for seq, s in enumerate(t['stops'], 1):
                    if JUNK_STOP.match(s['stop'].strip()): continue
                    key = re.sub(r'\s+', ' ', s['stop'].upper().strip())
                    c = coords.get(key)
                    if not c: continue
                    if key not in stops_seen:
                        sid_stop = slug(s['stop'])
                        while sid_stop in stops_seen.values(): sid_stop += '-2'
                        stops_seen[key] = sid_stop
                        stop_rows.append([sid_stop, s['stop'], round(c['lat'], 6), round(c['lon'], 6)])
                    h, m = re.split(r'[.:]', s['arr']); cur = int(h) * 60 + int(m)
                    if cur < prev_min - 2: offset = 24
                    prev_min = max(prev_min, cur)
                    pickup, dropoff = 0, 0
                    for rule in rules:
                        if rule['route_id'] == rid and rule['direction_id'] == (1 if t['reverse'] else 0) \
                                and rule['stop_match'] in s['stop'].upper():
                            # topology assertions: the rules are EXACT only for the
                            # current stop sequence — fail the build if it changes
                            pos = next(i for i, x in enumerate(t['stops']) if x is s)
                            up, down = pos, len(t['stops']) - pos - 1
                            if 'assert_upstream_stops' in rule and up != rule['assert_upstream_stops']:
                                raise SystemExit(
                                    f"PRESCRIPTION ASSERTION FAILED: {rid} trip {t['corsa']} has {up} upstream "
                                    f"stops before '{s['stop']}' (expected {rule['assert_upstream_stops']}). "
                                    f"The divieto encoding is no longer exact — re-derive the rule.")
                            if 'assert_downstream_stops' in rule and down != rule['assert_downstream_stops']:
                                raise SystemExit(
                                    f"PRESCRIPTION ASSERTION FAILED: {rid} trip {t['corsa']} has {down} downstream "
                                    f"stops after '{s['stop']}' (expected {rule['assert_downstream_stops']}). "
                                    f"The divieto encoding is no longer exact — re-derive the rule.")
                            pickup = rule['set'].get('pickup_type', pickup)
                            dropoff = rule['set'].get('drop_off_type', dropoff)
                    pending_st.append([trip_id, hms(s['arr'], offset and int(offset / 24)),
                                       hms(s['dep'], offset and int(offset / 24)), stops_seen[key], seq, pickup, dropoff])
                    pending_coords.append((c['lat'], c['lon']))
                if len(pending_st) < 2:
                    skipped.append((rid, t['corsa'], f'only {len(pending_st)} coordinate-resolved stops'))
                    continue
                # speed quarantine: a bad geocode or column misalignment must not ship
                bad_speed = False
                for (ra, ca), (rb, cb) in zip(zip(pending_st, pending_coords), zip(pending_st[1:], pending_coords[1:])):
                    ta = int(ra[1][:2]) * 60 + int(ra[1][3:5])
                    tb = int(rb[1][:2]) * 60 + int(rb[1][3:5])
                    km = hav_km(ca, cb)
                    if (tb <= ta and km > 3) or (tb > ta and km / ((tb - ta) / 60) > 110):
                        bad_speed = True; break
                if bad_speed:
                    skipped.append((rid, t['corsa'], 'speed-quarantine (bad geocode or column misalignment)'))
                    continue
                # duplicate-corsa artifacts ("11A" tokenized as "1"+"1A") → identical
                # signatures are dropped; distinct ones get a unique suffix
                sig = (rid, di, tuple((r[3], r[1]) for r in pending_st))
                if sig in trip_sigs:
                    skipped.append((rid, t['corsa'], 'duplicate trip signature')); continue
                trip_sigs.add(sig)
                while trip_id in trip_ids_seen: trip_id += 'b'
                trip_ids_seen.add(trip_id)
                for i, row in enumerate(pending_st, 1):
                    row[0] = trip_id
                    row[4] = i  # re-sequence after drops
                trip_rows.append([rid, sid, trip_id, headsign, 1 if t['reverse'] else 0])
                st_rows.extend(pending_st)

    for sid, dates in services_seen.items():
        for d in dates:
            cal_rows.append([sid, d.strftime('%Y%m%d'), 1])

    files = {
        'agency.txt': (['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'], agency_rows),
        'stops.txt': (['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], stop_rows),
        'routes.txt': (['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'], route_rows),
        'trips.txt': (['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id'], trip_rows),
        'stop_times.txt': (['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'], st_rows),
        'calendar_dates.txt': (['service_id', 'date', 'exception_type'], cal_rows),
        'feed_info.txt': (['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version', 'feed_contact_email'],
                          [['ManGO:IT', 'https://it.mangonese.dev', 'it',
                            FEED_START.strftime('%Y%m%d'), FEED_END.strftime('%Y%m%d'),
                            date.today().isoformat(), 'miconsig@gmail.com']]),
        'attributions.txt': (['attribution_id', 'organization_name', 'is_producer', 'is_operator', 'is_authority', 'attribution_url'],
                             [['1', 'ManGO:IT', 1, 0, 0, 'https://it.mangonese.dev'],
                              ['2', 'Regione Siciliana - Assessorato Infrastrutture e Mobilita', 0, 0, 1, 'https://pti.regione.sicilia.it'],
                              ['3', 'TUA Trasporti Urbani Agrigento', 0, 1, 0, 'https://www.trasportiurbaniagrigento.it'],
                              ['4', 'SAIS Autolinee', 0, 1, 0, 'https://www.saisautolinee.it']]),
    }
    zpath = os.path.join(OUT_DIR, 'sicily-coaches.gtfs.zip')
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for fn, (header, rows) in files.items():
            buf = io.StringIO()
            w = csv.writer(buf, lineterminator='\n')
            w.writerow(header); w.writerows(rows)
            z.writestr(fn, buf.getvalue())
    print(f'wrote {zpath}')
    print(f'  stops={len(stop_rows)} routes={len(route_rows)} trips={len(trip_rows)} stop_times={len(st_rows)} service_dates={len(cal_rows)}')
    if skipped:
        print('skipped:')
        for s in skipped: print('  ', s)


if __name__ == '__main__':
    main()
