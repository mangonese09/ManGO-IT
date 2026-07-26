# ── SAIS TRASPORTI CROSS-VERIFICATION ──
# Fetches the booking API for probe dates OUTSIDE the harvest sweep and
# compares corridor-level departures (dep, arr, linea) against what the
# emitted feed says runs that day. This exercises BOTH reconstructions:
# OD-matrix stitching (times) and calendar inference (extrapolated dates).
#
#   python pipeline/saist_verify.py
#
# Calendar inference is an approximation by design (documented); a mismatch
# here on a pattern the sweep could not have seen is a finding, not a bug —
# but times that disagree are a hard failure.
import csv, io, json, os, re, sys, zipfile
from datetime import date, timedelta

ROOT = os.path.dirname(__file__)
sys.path.insert(0, ROOT)
from saist_harvest import BASE, get, search_payload, load_graph, pretty_name, sweep_dates, hhmm_min

ZIP = os.path.join(ROOT, 'dist', 'sicily-coaches.gtfs.zip')

CORRIDORS = [
    ('109', '106', 'Agrigento -> Catania'),
    ('114', '106', 'Caltanissetta -> Catania'),
    ('109', '114', 'Agrigento -> Caltanissetta'),
]


def probe_dates():
    sweep = set(sweep_dates())
    picks, want_sunday = [], False
    d = min(sweep) + timedelta(days=1)
    while len(picks) < 2 and d < min(sweep) + timedelta(days=21):
        if d not in sweep and (d.weekday() == 6) == want_sunday:
            picks.append(d); want_sunday = True
        d += timedelta(days=1)
    return picks


def api_runs(a, b, d):
    dd = f'{d.day:02d}/{d.month:02d}/{d.year}'
    rr = f'{(d + timedelta(days=1)).day:02d}/{(d + timedelta(days=1)).month:02d}/{(d + timedelta(days=1)).year}'
    runs = search_payload(get(f'{BASE}?alias=search&from={a}&to={b}&type=1&lang=it-IT'
                              f'&departingdate={dd}&returningdate={rr}'))
    return {(r['Orario'], r['Ora_arrivo'], str(r['Linea']))
            for r in runs if r.get('Tipo') == 'Andata' and r.get('Validity') == 'true'
            and not (r.get('Giorno_arrivo') and r['Giorno_arrivo'][:2] != f'{d.day:02d}')}


def feed_runs(name_a, name_b, d):
    z = zipfile.ZipFile(ZIP)
    def rows(name):
        return list(csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8')))
    routes = {r['route_id']: r['route_short_name'] for r in rows('routes.txt')
              if r['route_id'].startswith('saist-')}
    day = d.strftime('%Y%m%d')
    active = {c['service_id'] for c in rows('calendar_dates.txt') if c['date'] == day}
    trips = {t['trip_id']: routes[t['route_id']] for t in rows('trips.txt')
             if t['route_id'] in routes and t['service_id'] in active}
    from stopnorm import canon_key
    sid = {s['stop_id']: canon_key(s['stop_name']) for s in rows('stops.txt')}
    from stopnorm import canon_key as _ck
    mm = json.load(open(os.path.join(ROOT, 'dist', 'stop-merge-map.json'), encoding='utf-8'))
    def _cname(n):
        return _ck(mm.get(re.sub(r'\s+', ' ', n.upper().strip()), n))
    ka, kb = _cname(name_a), _cname(name_b)
    by_trip = {}
    for st in rows('stop_times.txt'):
        if st['trip_id'] in trips:
            by_trip.setdefault(st['trip_id'], []).append(st)
    out = set()
    for tid, sts in by_trip.items():
        sts.sort(key=lambda r: int(r['stop_sequence']))
        ia = next((i for i, s in enumerate(sts) if sid[s['stop_id']] == ka), None)
        ib = next((i for i, s in enumerate(sts) if sid[s['stop_id']] == kb), None)
        if ia is not None and ib is not None and ia < ib:
            out.add((sts[ia]['departure_time'][:5], sts[ib]['arrival_time'][:5], trips[tid]))
    return out


def main():
    locs, _ = load_graph()
    name_of = {l['Id']: pretty_name(l['Descrizione']) for l in locs}
    fails = 0
    for a, b, label in CORRIDORS:
        for d in probe_dates():
            api = api_runs(a, b, d)
            feed = feed_runs(name_of[a], name_of[b], d)
            only_api, only_feed = api - feed, feed - api
            status = 'OK' if not only_api and not only_feed else 'MISMATCH'
            print(f'{label} {d}: api={len(api)} feed={len(feed)} -> {status}')
            for t in sorted(only_api)[:4]:
                print(f'   API-only:  {t[0]} -> {t[1]} linea {t[2]}')
            for t in sorted(only_feed)[:4]:
                print(f'   feed-only: {t[0]} -> {t[1]} linea {t[2]}')
            if status == 'MISMATCH':
                fails += 1
    if fails:
        print(f'FAIL - {fails} probe(s) mismatched')
        sys.exit(1)
    print('PASS - feed matches the live API on all probes')


if __name__ == '__main__':
    main()
