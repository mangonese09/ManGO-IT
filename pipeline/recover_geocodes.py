# ── GEOCODE RECOVERY (task 20) ──
# Wrong-province homonym geocodes (Fallica, Magazzinazzi, …) put a stop
# 50-150 km from the rest of its route, and the speed gate then quarantines
# every trip through it. Recovery, per the route-context design:
#
#   1. Suspects: stops (town/interpolated precision) sitting > SUSPECT_KM
#      from the centroid of EVERY route that contains them.
#   2. Re-geocode each suspect with Nominatim BOUNDED to a viewbox around
#      its route centroid — the town hint the original pass lacked.
#   3. Accept the hit only if it lands within ACCEPT_KM of the centroid;
#      write it to geocode-overrides.json (wins over cache on next
#      geocode.py run, which also re-interpolates dependent stops).
#
# Then: python pipeline/geocode.py && python pipeline/emit_gtfs.py && …
import json, math, os, re, statistics, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(__file__)
ROUTES = os.path.join(ROOT, 'data', 'routes')
OVERRIDES_F = os.path.join(ROOT, 'geocode-overrides.json')

UA = 'ManGO-IT-gtfs-pipeline/0.2 (personal project; miconsig@gmail.com)'
SUSPECT_KM = 40
ACCEPT_KM = 40


def hav_km(a, b):
    p = math.pi / 180
    return 2 * 6371 * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2 +
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def norm(name):
    return re.sub(r'\s+', ' ', name.upper().strip())


def nominatim_boxed(q, lat, lon, half_deg=0.45):
    box = f'{lon - half_deg},{lat + half_deg},{lon + half_deg},{lat - half_deg}'
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({
        'q': q, 'format': 'json', 'limit': 1, 'countrycodes': 'it',
        'viewbox': box, 'bounded': 1,
    })
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    time.sleep(1.1)
    try:
        rows = json.loads(urllib.request.urlopen(req, timeout=30).read())
        if rows:
            return float(rows[0]['lat']), float(rows[0]['lon'])
    except Exception as e:
        print('  nominatim error:', e)
    return None


def split_query(name):
    """Best re-geocode query for a stop name: prefer the town token."""
    n = re.sub(r'\s+[ap]\.\s*$', '', name.strip())
    m = re.match(r'^(.*?)\s*\((.+?)\)\s*$', n)
    if m:
        return f'{m.group(2).strip()}, {m.group(1).strip()}'
    n = re.sub(r'\bBV\.?\b|\bBIVIO\b', '', n, flags=re.I).strip()
    return n


def main():
    apply_mode = '--dry-run' not in sys.argv
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    sais_f = os.path.join(ROOT, 'data', 'sais-stop-coords.json')
    if os.path.exists(sais_f):
        coords.update(json.load(open(sais_f, encoding='utf-8')))
    overrides = json.load(open(OVERRIDES_F, encoding='utf-8')) if os.path.exists(OVERRIDES_F) else {}

    # stop -> set of routes; route -> resolved coords
    stops_routes = {}
    route_pts = {}
    for f in sorted(os.listdir(ROUTES)):
        route = json.load(open(os.path.join(ROUTES, f), encoding='utf-8'))
        if route.get('coords') == 'external':
            continue  # API-sourced coords are exact, never suspects
        rid = route['route_id']
        for d in route['directions']:
            for name in d['stops']:
                k = norm(name)
                stops_routes.setdefault(k, set()).add(rid)
                c = coords.get(k)
                if c:
                    route_pts.setdefault(rid, []).append((c['lat'], c['lon']))

    centroid = {rid: (statistics.median(p[0] for p in pts), statistics.median(p[1] for p in pts))
                for rid, pts in route_pts.items() if len(pts) >= 3}

    suspects = []
    for k, rids in stops_routes.items():
        c = coords.get(k)
        if not c or c.get('precision') not in ('town', 'street'):
            continue  # interpolated stops are re-derived after neighbors move
        if k in overrides:
            continue
        cds = [centroid[r] for r in rids if r in centroid]
        if not cds:
            continue
        dmin = min(hav_km((c['lat'], c['lon']), cd) for cd in cds)
        if dmin > SUSPECT_KM:
            best = min(cds, key=lambda cd: hav_km((c['lat'], c['lon']), cd))
            suspects.append((dmin, k, best))

    suspects.sort(reverse=True)
    print(f'{len(suspects)} suspects (> {SUSPECT_KM}km from every containing route centroid)')
    fixed, unresolved = 0, []
    for dmin, k, (clat, clon) in suspects:
        q = split_query(k.title())
        hit = nominatim_boxed(f'{q}, Sicilia', clat, clon)
        if not hit:
            hit = nominatim_boxed(q, clat, clon)
        if hit and hav_km(hit, (clat, clon)) <= ACCEPT_KM:
            print(f'  FIX {k[:48]:48s} {dmin:5.0f}km off -> {hit[0]:.5f},{hit[1]:.5f}')
            overrides[k] = {'lat': hit[0], 'lon': hit[1],
                            'note': f'route-context recovery (was {dmin:.0f}km from route)'}
            fixed += 1
        else:
            unresolved.append((dmin, k))
    if apply_mode and fixed:
        json.dump(overrides, open(OVERRIDES_F, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'{fixed} overrides written to geocode-overrides.json')
    if unresolved:
        print(f'{len(unresolved)} suspects unresolved (no bounded hit):')
        for dmin, k in unresolved[:20]:
            print(f'  {dmin:5.0f}km  {k[:60]}')


if __name__ == '__main__':
    main()
