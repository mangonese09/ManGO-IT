# ── EXPORT COACH STOPS ──
# stop-coords.json + route stop names → server/coach-stops.json, feeding the
# proxy's autocomplete so coach stops are searchable before Transitous ingests.
import json, os, re

ROOT = os.path.dirname(__file__)


def to_min(t):
    h, m = re.split(r'[.:]', t)
    return int(h) * 60 + int(m)


def main():
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    sais_f = os.path.join(ROOT, 'data', 'sais-stop-coords.json')
    if os.path.exists(sais_f):
        coords.update(json.load(open(sais_f, encoding='utf-8')))
    names, order = {}, []
    trips = []
    for f in sorted(os.listdir(os.path.join(ROOT, 'data', 'routes'))):
        r = json.load(open(os.path.join(ROOT, 'data', 'routes', f), encoding='utf-8'))
        for d in r['directions']:
            for t in d['trips']:
                if not t['valid']: continue
                seq = []
                for s in t['stops']:
                    key = re.sub(r'\s+', ' ', s['stop'].upper().strip())
                    c = coords.get(key)
                    if not c: continue
                    if key not in names:
                        names[key] = len(order)
                        order.append({'n': s['stop'], 'lat': round(c['lat'], 5), 'lon': round(c['lon'], 5)})
                    seq.append([names[key], to_min(s['dep'])])
                if len(seq) >= 2:
                    svc = t['service']
                    row = {'r': r['name'][:60], 'op': r['operator'],
                           'd': svc['days'], 'sc': svc['school'],
                           'se': svc['season'], 's': seq}
                    if svc.get('explicit_dates'):
                        row['xd'] = svc['explicit_dates']  # exact ISO dates (SAIS/Albatross)
                    trips.append(row)
    json.dump(order, open(os.path.join(ROOT, '..', 'server', 'coach-stops.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(trips, open(os.path.join(ROOT, '..', 'server', 'coach-trips.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'{len(order)} coach stops, {len(trips)} trips -> server/coach-{{stops,trips}}.json')


if __name__ == '__main__':
    main()
