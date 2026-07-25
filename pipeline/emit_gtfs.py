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
    days, school, season = svc['days'], svc['school'], svc['season']
    out = []
    d = FEED_START
    while d <= FEED_END:
        wd = d.weekday()
        run = False
        if days == 'sun-holidays':
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
    parts = [svc['days']]
    if svc['school']: parts.append(svc['school'])
    if svc['season']: parts.append(f"s{svc['season']['from'].replace('/', '')}-{svc['season']['to'].replace('/', '')}")
    return re.sub(r'[^a-z0-9\-]', '', '-'.join(parts))


def hms(t, wrapped_offset=0):
    h, m = re.split(r'[.:]', t)
    return f'{int(h) + wrapped_offset:02d}:{int(m):02d}:00'


def main():
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    os.makedirs(OUT_DIR, exist_ok=True)

    agency_rows, route_rows, trip_rows, st_rows, cal_rows = [], [], [], [], []
    stop_rows, stops_seen, services_seen = [], {}, {}
    agencies_seen = {}
    skipped = []

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
        route_rows.append([rid, aid, cod.group(1) if cod else '', route['name'], 3])
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
                trip_rows.append([rid, sid, trip_id, headsign, 1 if t['reverse'] else 0])
                prev_min, offset = -1, 0
                for seq, s in enumerate(t['stops'], 1):
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
                    st_rows.append([trip_id, hms(s['arr'], offset and int(offset / 24)),
                                    hms(s['dep'], offset and int(offset / 24)), stops_seen[key], seq, 0, 0])

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
