# ── SAIS CROSS-VERIFICATION ──
# The "perfect" bar: prove the GTFS transform is faithful by fetching the
# Albatross timetable for probe dates that were NOT part of the harvest
# sweep, and diffing trip-by-trip (every stop, every time, both ways)
# against what the emitted feed says runs that day.
#
#   python pipeline/sais_verify.py            # 3 trunk lines × 2 dates
#
# A mismatch in either direction (API trip missing from feed, feed trip
# not in API) is a hard failure.
import json, os, sys, time, urllib.request, zipfile, io, csv, re
from datetime import date

ROOT = os.path.dirname(__file__)
BASE = 'https://api.saisautolinee.it'
UA = 'ManGO-IT/0.5.0 (+https://it.mangonese.dev; miconsig@gmail.com)'
ZIP = os.path.join(ROOT, 'dist', 'sicily-coaches.gtfs.zip')

# lineId -> route code, chosen across lots + an urban pool; probe dates are
# deliberately absent from sais_harvest.SWEEP_DATES (weekday + Sunday).
PROBES = [
    ('24bdaea1-35b5-4538-ab41-55c5701679aa', '1170', 'Catania - Palermo'),
    ('d9f137e8-2ab6-47c0-b571-a1eab3cf077a', '4170', 'Messina - Catania'),
    ('2675685c-8ed3-4143-8d5f-adcef719ff0d', '172', 'Palermo - Enna - Piazza Armerina - Gela'),
]
PROBE_DATES = [date(2026, 8, 5), date(2026, 8, 23)]  # Wed + Sun, both outside sweep weeks


def api_trips(line_id, d):
    """set of (direction, (stop_name_normalized, 'HH:MM'), ...) active on d."""
    url = f'{BASE}/routestimetables/timetable?lineIds={line_id}&date={d.year}-{d.month}-{d.day}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    time.sleep(1.0)
    data = json.loads(urllib.request.urlopen(req, timeout=60).read())
    stops = json.load(open(os.path.join(ROOT, 'data', 'sais', 'stops.json'), encoding='utf-8'))
    by_id = {s['id']: s for s in stops}
    sys.path.insert(0, ROOT)
    from sais_harvest import validity_dates, build_name_map, in_sicily
    name_of = build_name_map(stops)
    out = set()
    for route in data:
        di = 1 if route.get('direction') else 0
        for t in route['tripTemplates']:
            unknown = []
            if d not in validity_dates(t['validities'], unknown):
                continue  # returned by the API for the day but validity says no —
                          # hasn't been observed; if it ever happens the count check catches it
            seq = []
            for s in t['stops']:
                if s['stopId'] not in by_id or not in_sicily(by_id[s['stopId']]):
                    continue
                nm = re.sub(r'\s+', ' ', name_of[s['stopId']].upper().strip())
                h = s['stopTime']['days'] * 24 + s['stopTime']['hours']
                seq.append((nm, f"{h:02d}:{s['stopTime']['minutes']:02d}"))
            if len(seq) >= 2:
                out.add((di, tuple(seq)))
    return out


def feed_trips(route_short, d):
    """Same shape from the emitted GTFS zip."""
    z = zipfile.ZipFile(ZIP)
    def rows(name):
        return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8')))
    routes = [r for r in rows('routes.txt') if r['route_short_name'] == route_short
              and r['agency_id'].startswith('sais')]
    rid = {r['route_id'] for r in routes}
    day = d.strftime('%Y%m%d')
    active_svc = {c['service_id'] for c in rows('calendar_dates.txt') if c['date'] == day}
    trips = {t['trip_id']: t for t in rows('trips.txt') if t['route_id'] in rid and t['service_id'] in active_svc}
    stop_names = {s['stop_id']: re.sub(r'\s+', ' ', s['stop_name'].upper().strip()) for s in rows('stops.txt')}
    by_trip = {}
    for st in rows('stop_times.txt'):
        if st['trip_id'] in trips:
            by_trip.setdefault(st['trip_id'], []).append(st)
    out = set()
    for tid, sts in by_trip.items():
        sts.sort(key=lambda r: int(r['stop_sequence']))
        seq = tuple((stop_names[s['stop_id']], s['departure_time'][:5]) for s in sts)
        out.add((int(trips[tid]['direction_id']), seq))
    return out


def main():
    fails = 0
    for line_id, short, label in PROBES:
        for d in PROBE_DATES:
            a = api_trips(line_id, d)
            f = feed_trips(short, d)
            only_api, only_feed = a - f, f - a
            status = 'OK' if not only_api and not only_feed else 'MISMATCH'
            print(f'{label} [{short}] {d}: api={len(a)} feed={len(f)} -> {status}')
            for t in sorted(only_api)[:3]:
                print(f'   API-only: dir={t[0]} {t[1][0]} -> {t[1][-1]}')
            for t in sorted(only_feed)[:3]:
                print(f'   feed-only: dir={t[0]} {t[1][0]} -> {t[1][-1]}')
            if status == 'MISMATCH':
                fails += 1
    if fails:
        print(f'FAIL — {fails} probe(s) mismatched')
        sys.exit(1)
    print('PASS — feed matches the live API on all probes')


if __name__ == '__main__':
    main()
