# ── EXPORT COACH STOPS ──
# stop-coords.json + route stop names → server/coach-stops.json, feeding the
# proxy's autocomplete so coach stops are searchable before Transitous ingests.
import json, os, re

ROOT = os.path.dirname(__file__)


def main():
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    names = {}
    for f in os.listdir(os.path.join(ROOT, 'data', 'routes')):
        r = json.load(open(os.path.join(ROOT, 'data', 'routes', f), encoding='utf-8'))
        for d in r['directions']:
            for s in d['stops']:
                key = re.sub(r'\s+', ' ', s.upper().strip())
                if key in coords and coords[key] and key not in names:
                    c = coords[key]
                    names[key] = {'n': s, 'lat': round(c['lat'], 5), 'lon': round(c['lon'], 5)}
    out = sorted(names.values(), key=lambda s: s['n'])
    dest = os.path.join(ROOT, '..', 'server', 'coach-stops.json')
    json.dump(out, open(dest, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'{len(out)} coach stops -> server/coach-stops.json')


if __name__ == '__main__':
    main()
