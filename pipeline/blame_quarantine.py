# ── QUARANTINE BLAME ──
# Which stops' coordinates are responsible for the speed-quarantined trips?
# For every route-JSON trip that emit_gtfs would quarantine, find the legs
# that violate the speed gate and tally the stops involved. A stop that
# appears in many violating legs across many routes is almost certainly a
# wrong-province geocode (homonym towns: Fallica, Magazzinazzi, ...).
#
#   python pipeline/blame_quarantine.py            # top offenders
#   python pipeline/blame_quarantine.py --routes   # per-route breakdown
import json, math, os, re, sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(__file__)
ROUTES = os.path.join(ROOT, 'data', 'routes')


def hav_km(a, b):
    p = math.pi / 180
    return 2 * 6371 * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2 +
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def norm(name):
    return re.sub(r'\s+', ' ', name.upper().strip())


def main():
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    sais_f = os.path.join(ROOT, 'data', 'sais-stop-coords.json')
    if os.path.exists(sais_f):
        coords.update(json.load(open(sais_f, encoding='utf-8')))

    blame = Counter()          # stop → # violating legs it participates in
    partner = defaultdict(Counter)
    routes_of = defaultdict(set)
    quarantined = 0
    for f in sorted(os.listdir(ROUTES)):
        route = json.load(open(os.path.join(ROUTES, f), encoding='utf-8'))
        for d in route['directions']:
            for t in d['trips']:
                if not t['valid']:
                    continue
                seq = []
                for s in t['stops']:
                    c = coords.get(norm(s['stop']))
                    if not c:
                        continue
                    h, m = re.split(r'[.:]', s['arr'])
                    seq.append((int(h) * 60 + int(m), (c['lat'], c['lon']), s['stop']))
                if len(seq) < 2:
                    continue
                legs = []
                for a, b in zip(seq, seq[1:]):
                    km = hav_km(a[1], b[1])
                    dt = b[0] - a[0]
                    if (dt <= 0 and km > 3) or (dt > 0 and km / (dt / 60) > 110):
                        legs.append((a[2], b[2], km, dt))
                if legs:
                    quarantined += 1
                    for a_name, b_name, km, dt in legs:
                        blame[norm(a_name)] += 1
                        blame[norm(b_name)] += 1
                        partner[norm(a_name)][norm(b_name)] += 1
                        partner[norm(b_name)][norm(a_name)] += 1
                        routes_of[norm(a_name)].add(route['route_id'])
                        routes_of[norm(b_name)].add(route['route_id'])

    print(f'{quarantined} trips currently speed-quarantined')
    print(f'{len(blame)} distinct stops involved; top offenders:')
    for name, n in blame.most_common(40):
        c = coords.get(name)
        prec = c.get('precision') if c else '?'
        rts = ','.join(sorted(routes_of[name])[:3])
        print(f'  {n:4d}  {name[:52]:52s} prec={prec:12s} lat={c["lat"]:.4f} lon={c["lon"]:.4f} routes={rts}')


if __name__ == '__main__':
    main()
