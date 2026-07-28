"""Phase 1A query matrix runner.

For each OD pair x day type, collects three answers:
  live_untuned — api.transitous.org v3 plan, MOTIS defaults (what users got
                 before the F-1 tuning shipped)
  live_tuned   — same query with the deployed proxy's tuning params
  csa          — earliest-arrival over our own feed (audit_csa), the
                 "with-feed" baseline for post-PR-#2327 expectations
Raw upstream responses are cached in docs/audit/matrix-cache/ so re-runs are
free; summary lands in docs/audit/matrix-results.json.

Depart-after is 08:00 Europe/Rome (06:00Z, CEST holds for all five dates).
"""
import hashlib
import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit_csa import Network

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CACHE_DIR = os.path.join(ROOT, 'docs', 'audit', 'matrix-cache')
OUT = os.path.join(ROOT, 'docs', 'audit', 'matrix-results.json')
UA = 'ManGO-IT/0.6 audit (+https://it.mangonese.dev; miconsig@gmail.com)'
TRANSITOUS = 'https://api.transitous.org/api/v3/plan'

# (lat, lon) query points: terminal / station areas
P = {
    'Raffadali': (37.404053, 13.532076),        # P.zza Voltano
    'Agrigento': (37.311376, 13.587182),        # P.le Rosselli
    'Palermo': (38.1113, 13.3706),              # via Balsamo (coach terminals + Centrale)
    'Palermo Centrale': (38.1090, 13.3665),
    'Catania': (37.502361, 15.087372),          # Terminal Bus via Archimede (Centrale adjacent)
    'Enna': (37.5668, 14.2807),                 # Terminal viale Diaz
    # NOTE: first run used (37.0316,15.2124) — a misgeocoded feed cluster in
    # open country 4 km SW of town; real C.so Umberto terminal below.
    'Siracusa': (37.0708, 15.2854),
    'Sciacca': (37.5068, 13.0819),
    'Gela': (37.0664, 14.2502),                 # Terminal Stazione FS
    'Caltanissetta': (37.4903, 14.0633),        # Autostazione p.le Rochester
    'Modica': (36.8666, 14.7568),               # p.za Borsellino
    'Milazzo': (38.2208, 15.2415),
    'Messina': (38.1938, 15.5542),              # via Bonino capolinea
    'Messina Centrale': (38.1830, 15.5567),
    'Cattolica Eraclea': (37.4401, 13.3873),
    'Cefalu': (38.0377, 14.0231),               # stazione
    'Taormina': (37.8512, 15.2830),
    'Termini Imerese': (37.9855, 13.7003),      # stazione
}

PAIRS = [
    # (from, to, class) — class: coach = feed differentiator, rail = live control, mixed
    ('Raffadali', 'Catania', 'coach-transfer'),
    ('Raffadali', 'Agrigento', 'coach-rural'),
    ('Palermo', 'Agrigento', 'coach-trunk'),
    ('Agrigento', 'Catania', 'coach-trunk'),
    ('Palermo', 'Catania', 'coach-trunk'),
    ('Catania', 'Enna', 'coach-trunk'),
    ('Siracusa', 'Catania', 'mixed'),
    ('Sciacca', 'Palermo', 'coach-trunk'),
    ('Sciacca', 'Agrigento', 'coach-rural'),
    ('Gela', 'Catania', 'coach-trunk'),
    ('Caltanissetta', 'Palermo', 'coach-trunk'),
    ('Modica', 'Catania', 'mixed'),
    ('Milazzo', 'Messina', 'mixed'),
    ('Cattolica Eraclea', 'Agrigento', 'coach-rural'),
    ('Palermo', 'Messina', 'mixed'),
    ('Enna', 'Caltanissetta', 'coach-rural'),
    ('Palermo Centrale', 'Cefalu', 'rail-control'),
    ('Catania', 'Taormina', 'mixed'),
    ('Messina Centrale', 'Catania', 'rail-control'),
    ('Palermo Centrale', 'Termini Imerese', 'rail-control'),
]

DATES = [
    ('20260805', '2026-08-05', 'feriale agosto (Wed)'),
    ('20260808', '2026-08-08', 'sabato (Sat)'),
    ('20260809', '2026-08-09', 'festivo (Sun)'),
    ('20260815', '2026-08-15', 'Ferragosto (Sat)'),
    ('20260923', '2026-09-23', 'feriale scolastico (Wed)'),
]

TUNED = {
    'searchWindow': '21600', 'maxMatchingDistance': '600',
    'additionalTransferTime': '3',
    'maxPreTransitTime': '1800', 'maxPostTransitTime': '1800',
}


def fetch_plan(from_ll, to_ll, iso_date, tuned):
    params = {
        'fromPlace': f'{from_ll[0]},{from_ll[1]}',
        'toPlace': f'{to_ll[0]},{to_ll[1]}',
        'time': f'{iso_date}T06:00:00Z',
        'numItineraries': '6',
    }
    if tuned:
        params.update(TUNED)
    url = TRANSITOUS + '?' + urllib.parse.urlencode(params)
    key = hashlib.sha1(url.encode()).hexdigest()[:20]
    cpath = os.path.join(CACHE_DIR, key + '.json')
    if os.path.exists(cpath):
        with open(cpath, encoding='utf-8') as f:
            return json.load(f), True
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    started = time.time()
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.load(r)
            break
        except Exception as e:
            if attempt == 2:
                data = {'error': str(e)}
            else:
                time.sleep(5)
    data['_meta'] = {'url': url, 'elapsed_s': round(time.time() - started, 2)}
    with open(cpath, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    return data, False


def summarize_live(data):
    if 'error' in data:
        return {'status': 'ERROR', 'error': data['error']}
    its = data.get('itineraries') or []
    if not its:
        return {'status': 'NONE', 'n': 0, 'elapsed_s': data.get('_meta', {}).get('elapsed_s')}
    out = []

    from datetime import datetime, timedelta

    def rome(iso, ref_iso=None):
        # upstream times are UTC ('Z'); all five audit dates are CEST (+2).
        # ref_iso = itinerary start: arrivals on a later Rome day get '+1d'.
        if not iso or len(iso) < 16:
            return ''
        t = datetime.fromisoformat(iso[:16]) + timedelta(hours=2)
        tag = ''
        if ref_iso:
            r = datetime.fromisoformat(ref_iso[:16]) + timedelta(hours=2)
            if t.date() > r.date():
                tag = '+1d'
        return t.strftime('%H:%M') + tag

    for it in its:
        legs = [l for l in (it.get('legs') or []) if l.get('mode') != 'WALK']
        out.append({
            'dep': rome(it.get('startTime')),
            'arr': rome(it.get('endTime'), it.get('startTime')),
            'duration_min': round((it.get('duration') or 0) / 60),
            'transfers': max(0, len(legs) - 1),
            'legs': [f"{l.get('mode')}:{l.get('routeShortName') or l.get('routeLongName') or ''}"
                     f"@{(l.get('agencyName') or '?')}" for l in legs],
            '_end_iso': it.get('endTime') or '9999',
        })
    best = min(out, key=lambda x: x['_end_iso'])
    for o in out:
        del o['_end_iso']
    return {'status': 'OK', 'n': len(out), 'best': best, 'all': out,
            'elapsed_s': data.get('_meta', {}).get('elapsed_s')}


def summarize_csa(net, from_ll, to_ll, date8):
    j = net.query(from_ll, to_ll, date8, 8 * 3600)
    if not j:
        return {'status': 'NONE'}
    deps = net.departures(from_ll, to_ll, date8)
    return {
        'status': 'OK',
        'best': {'dep': j['dep'], 'arr': j['arr'], 'transfers': j['transfers'],
                 'legs': [f"COACH:{l['route'][:34]}@{l['agency']}" for l in j['legs']]},
        'day_departures': len(deps),
    }


def main():
    os.makedirs(CACHE_DIR, exist_ok=True)
    net = Network(os.path.join(ROOT, 'pipeline', 'dist', 'sicily-coaches.gtfs.zip'))
    results = []
    n_live = 0
    for fname, tname, klass in PAIRS:
        for date8, iso, dlabel in DATES:
            row = {'from': fname, 'to': tname, 'class': klass, 'date': iso, 'day': dlabel}
            for variant in ('untuned', 'tuned'):
                data, cached = fetch_plan(P[fname], P[tname], iso, variant == 'tuned')
                row['live_' + variant] = summarize_live(data)
                if not cached:
                    n_live += 1
                    time.sleep(1.6)
            row['csa'] = summarize_csa(net, P[fname], P[tname], date8)
            results.append(row)
            b = lambda s: (s.get('best', {}).get('dep', '—') + '->' + s.get('best', {}).get('arr', '—')) if s.get('status') == 'OK' else s.get('status')
            print(f"{fname}->{tname} {iso}: untuned={b(row['live_untuned'])} tuned={b(row['live_tuned'])} csa={b(row['csa'])}", flush=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'generated': '2026-07-28', 'depart_after': '08:00 Europe/Rome',
                   'pairs': len(PAIRS), 'dates': len(DATES), 'results': results}, f, indent=1)
    print(f'\n{len(results)} cells, {n_live} live calls this run -> {OUT}')


if __name__ == '__main__':
    main()
