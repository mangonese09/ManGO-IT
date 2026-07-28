# ── STAGE 4: GEOCODE ──
# Stop names → coordinates. Nominatim (1.1s politeness delay, permanent cache),
# manual overrides win, and stops that won't geocode (road junctions, "BV. X")
# are interpolated between geocoded neighbours using the timetable's own KM
# column. Every resolution is tagged with its precision.
import json, os, re, time, math, urllib.request, urllib.parse
from statistics import median

from stopnorm import apply_renames

ROOT = os.path.dirname(__file__)
ROUTES = os.path.join(ROOT, 'data', 'routes')
CACHE_F = os.path.join(ROOT, 'data', 'geocode-cache.json')
OVERRIDES_F = os.path.join(ROOT, 'geocode-overrides.json')

UA = 'ManGO-IT-gtfs-pipeline/0.1 (personal project; miconsig@gmail.com)'
SICILY_VIEWBOX = '11.9,38.9,15.8,36.5'  # lon,lat,lon,lat
SICILY = dict(latMin=36.5, latMax=38.9, lonMin=11.9, lonMax=15.8)

cache = json.load(open(CACHE_F, encoding='utf-8')) if os.path.exists(CACHE_F) else {}
overrides = json.load(open(OVERRIDES_F, encoding='utf-8')) if os.path.exists(OVERRIDES_F) else {}


def nominatim(q):
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({
        'q': q, 'format': 'json', 'limit': 1, 'countrycodes': 'it',
        'viewbox': SICILY_VIEWBOX, 'bounded': 1,
    })
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    time.sleep(1.1)
    try:
        rows = json.loads(urllib.request.urlopen(req, timeout=30).read())
        if rows:
            lat, lon = float(rows[0]['lat']), float(rows[0]['lon'])
            if SICILY['latMin'] <= lat <= SICILY['latMax'] and SICILY['lonMin'] <= lon <= SICILY['lonMax']:
                return lat, lon, rows[0].get('type', '')
    except Exception as e:
        print('  nominatim error:', e)
    return None


def split_stop(name):
    """'SIRACUSA p. (C.so Umberto/…)' → town + detail."""
    n = re.sub(r'\s+[ap]\.\s*$', '', name.strip())
    m = re.match(r'^(.*?)\s*\((.+?)\)\s*$', n)
    if m: return m.group(1).strip(), m.group(2).strip()
    m = re.match(r'^([A-Z\'\. ]{3,}?)\s+((?:via|viale|corso|c\.so|piazza|p\.zza|largo|contrada|ss)\b.*)$', n, re.I)
    if m: return m.group(1).strip(), m.group(2).strip()
    return n, ''


# Sheet spellings that differ from OSM's
SPELLFIX = {
    'CAPOPASSERO': 'CAPO PASSERO',
}


def geocode_name(name):
    for bad, good in SPELLFIX.items():
        name = re.sub(bad, good, name, flags=re.I)
    # RG-province AST sheets decorate termini: 'MODICA (p.za Borsellino)- Capolinea',
    # '0 MODICA (ZONA 167) CAPOLINEA\FERMATA'. Nominatim chokes on the suffix and
    # the miss was cached, silently dropping the terminus from every trip
    # (matrix regression: Modica→Catania NONE despite 44 emitted trips).
    name = re.sub(r'\s*-?\s*Capolinea(\\Fermata)?( di (Partenza|Arrivo))?\s*$', '', name, flags=re.I)
    name = re.sub(r'^\s*\d{1,2}\s+(?=\S)', '', name)
    key = re.sub(r'\s+', ' ', name.upper().strip())
    if key in overrides:
        o = overrides[key]
        if o.get('interpolate'):
            # explicit "no pin exists": force km/index interpolation between
            # geocoded neighbours (localities Nominatim doesn't know, e.g.
            # FALLICA on the Tumino S. Croce Camerina sheets)
            return None
        return {'lat': o['lat'], 'lon': o['lon'], 'precision': 'override'}
    if key in cache:
        return cache[key]
    town, detail = split_stop(name)
    town_q = re.sub(r'\bBV\.?\b|\bBIVIO\b', '', town, flags=re.I).strip()
    result = None
    if detail and not re.match(r'^ss\s*\d', detail, re.I):
        hit = nominatim(f'{detail}, {town_q}, Sicilia')
        if hit: result = {'lat': hit[0], 'lon': hit[1], 'precision': 'street'}
    if not result and town_q:
        hit = nominatim(f'{town_q}, Sicilia')
        if hit: result = {'lat': hit[0], 'lon': hit[1], 'precision': 'town'}
    cache[key] = result  # cache misses too (None) so we don't re-ask
    return result


def km_of(kms):
    for k in kms or []:
        try: return float(k.replace(',', '.'))
        except ValueError: pass
    return None


def rep_minutes(d):
    """Representative elapsed minutes per stop index, median across the
    direction's trips. Used as interpolation weight when the sheet has no KM
    column: index-even spacing puts same-minute clustered stops kilometres
    apart and fabricates speed-gate violations (Cuffaro SS189 bivios); the
    operator's own timings place them honestly."""
    per_idx = {}
    for t in d.get('trips', []):
        base, seen = None, []
        for s in t.get('stops', []):
            m = re.split(r'[.:]', s.get('arr') or '')
            if len(m) < 2 or not m[0].isdigit() or not m[1].isdigit():
                continue
            v = int(m[0]) * 60 + int(m[1])
            if base is None:
                base = v
            v -= base
            if v < 0:
                v += 1440
            seen.append((s['idx'], v))
        if not seen:
            continue
        if t.get('reverse'):
            # a return run visits the stop list backwards: mirror its elapsed
            # times so idx 0 is always the route origin, or medians mixing
            # both directions collapse to a constant and lose the proportions
            total = max(v for _i, v in seen)
            seen = [(i, total - v) for i, v in seen]
        for i, v in seen:
            per_idx.setdefault(i, []).append(v)
    return [median(per_idx[i]) if i in per_idx else None for i in range(len(d['stops']))]


def interpolate(missing_idx, coords, kms, mins=None):
    """Linear interpolation between nearest geocoded neighbours by km,
    falling back to elapsed-time proportion, then index spacing."""
    before = next((i for i in range(missing_idx - 1, -1, -1) if coords[i]), None)
    after = next((i for i in range(missing_idx + 1, len(coords)) if coords[i]), None)
    if before is None or after is None: return None
    k0, k1, km = kms[before], kms[after], kms[missing_idx]
    m0 = mins[before] if mins else None
    m1 = mins[after] if mins else None
    mm = mins[missing_idx] if mins else None
    if None not in (k0, k1, km) and k1 != k0:
        f = (km - k0) / (k1 - k0)
    elif None not in (m0, m1, mm) and m1 != m0:
        f = (mm - m0) / (m1 - m0)
    else:
        f = (missing_idx - before) / (after - before)
    f = min(1, max(0, f))
    a, b = coords[before], coords[after]
    return {'lat': a['lat'] + (b['lat'] - a['lat']) * f,
            'lon': a['lon'] + (b['lon'] - a['lon']) * f,
            'precision': 'interpolated'}


def main():
    stops_out = {}
    for f in sorted(os.listdir(ROUTES)):
        route = apply_renames(json.load(open(os.path.join(ROUTES, f), encoding='utf-8')))
        if route.get('coords') == 'external':
            continue  # SAIS et al.: exact coords ship in data/sais-stop-coords.json
        for d in route['directions']:
            names = d['stops']
            kms = [None] * len(names)
            # km isn't carried per stop here; interpolate() falls back to
            # elapsed-time proportion from the trips, then index spacing
            mins = rep_minutes(d)
            coords = []
            for n in names:
                g = geocode_name(n)
                coords.append(g)
            for i, (n, c) in enumerate(zip(names, coords)):
                if c is None:
                    coords[i] = interpolate(i, coords, kms, mins)
            for n, c in zip(names, coords):
                key = re.sub(r'\s+', ' ', n.upper().strip())
                if key not in stops_out or (c and stops_out[key] is None):
                    stops_out[key] = c
        json.dump(cache, open(CACHE_F, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    resolved = {k: v for k, v in stops_out.items() if v}
    missing = [k for k, v in stops_out.items() if not v]
    json.dump(resolved, open(os.path.join(ROOT, 'data', 'stop-coords.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print(f'geocoded {len(resolved)}/{len(stops_out)} stops')
    by_prec = {}
    for v in resolved.values(): by_prec[v['precision']] = by_prec.get(v['precision'], 0) + 1
    print('precision:', by_prec)
    if missing:
        print('MISSING (need overrides):')
        for k in missing: print('  ', k)


if __name__ == '__main__':
    main()
