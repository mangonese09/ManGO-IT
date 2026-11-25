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

# Nominatim asks for an identifying UA; the contact address comes from the environment, not the repo
UA = 'ManGO-IT-gtfs-pipeline/0.1 (+https://it.mangonese.dev' + ('; ' + os.environ['MANGOIT_CONTACT'] if os.environ.get('MANGOIT_CONTACT') else '') + ')'
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
        # "Via Libertà n. 106 - ang. Viale Lazio" finds nothing; "Via Libertà 106" does. The
        # simplified street goes first, the sheet's full wording second (lot sheets, 2026-11-25).
        short = re.split(r'\s+-\s+|\s+ang\.?\s+|/', re.sub(r'\bn\.\s*', '', detail, flags=re.I))[0].strip(' ,')
        for q in dict.fromkeys([short, detail]):
            if not q:
                continue
            hit = nominatim(f'{q}, {town_q}, Sicilia')
            if hit:
                result = {'lat': hit[0], 'lon': hit[1], 'precision': 'street'}
                break
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


def hav_km(a, b):
    import math
    la1, lo1, la2, lo2 = map(math.radians, (a['lat'], a['lon'], b['lat'], b['lon']))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def town_fallback(name):
    """A stop vetting dropped and nothing could interpolate: its geocode, unless that is a street
    match far from its own town, in which case the town centre is nearer the truth."""
    g = geocode_name(name)
    if g and g.get('precision') == 'street':
        centre = geocode_name(split_stop(name)[0])
        if centre and hav_km(g, centre) > 8:
            return dict(centre, precision='town')
    return g


def km_vet(names, coords, kms, mins=None):
    """Lot sheets (lots_parse.py) give km per stop, or at least exact times, which beat a weak
    geocode. Each pair of neighbouring placed stops must be reachable: within 1.4 x the km
    difference + 3 km, or (no km) 110 km/h over the timetable minutes + 2 km. While a pair breaks
    that, the less trustworthy stop of the worst pair is dropped so interpolation places it."""
    out = list(coords)
    for i, (n, c) in enumerate(zip(names, out)):
        if c and c.get('precision') == 'town' and split_stop(n)[1] and kms[i] is not None:
            out[i] = None
        elif c and c.get('precision') == 'street':
            # "PALERMO (Via Roma n. 265)" matched another town's Via Roma, 55 km off
            centre = geocode_name(split_stop(n)[0])
            if centre and hav_km(c, centre) > 8:
                out[i] = None  # interpolated by km; town_fallback() if nothing to interpolate from
    rank ={'override': 3, 'street': 2, 'interpolated': 1, 'town': 0}

    def limit(i, j):
        if kms[i] is not None and kms[j] is not None:
            return abs(kms[i] - kms[j]) * 1.4 + 3
        if mins and mins[i] is not None and mins[j] is not None:
            return abs(mins[j] - mins[i]) / 60 * 110 + 2
        return None

    def breaks(i, j):
        lim = limit(i, j)
        return lim is not None and hav_km(out[i], out[j]) > lim

    for _ in range(len(out)):
        placed = [i for i, c in enumerate(out) if c]
        if len(placed) <= 2:
            break
        worst = None
        for i, j in zip(placed, placed[1:]):
            lim = limit(i, j)
            if lim is None:
                continue
            over = hav_km(out[i], out[j]) - lim
            if over > 0 and (worst is None or over > worst[0]):
                worst = (over, i, j)
        if not worst:
            break
        _, i, j = worst
        ri, rj = rank.get(out[i].get('precision'), 0), rank.get(out[j].get('precision'), 0)
        if ri != rj:
            out[i if ri < rj else j] = None
        else:  # same trust: drop the one that also disagrees with its other neighbour
            p = placed.index(i)
            before = placed[p - 1] if p > 0 else None
            out[i if before is not None and breaks(before, i) else j] = None
    return out


def main():
    stops_out = {}
    # Stops are shared by name across routes and the first placement wins. The older routes go
    # first so a lot sheet's vetting can never move a stop they already use ("MASCALI").
    files = sorted(os.listdir(ROUTES), key=lambda f: (f.startswith('lot'), f))
    # routes the lot sheets replaced (dedupe_lots.py) are not emitted, so they place no stops
    sup_path = os.path.join(ROOT, 'data', 'lots-superseded.json')
    superseded = json.load(open(sup_path, encoding='utf-8')) if os.path.exists(sup_path) else {}
    for f in files:
        route = apply_renames(json.load(open(os.path.join(ROUTES, f), encoding='utf-8')))
        if route.get('route_id') in superseded:
            continue
        if route.get('coords') == 'external':
            continue  # SAIS et al.: exact coords ship in data/sais-stop-coords.json
        for d in route['directions']:
            names = d['stops']
            # lot sheets (lots_parse.py) carry km per stop; the others don't, and
            kms = d.get('kms') or [None] * len(names)
            # where km is missing interpolate() falls back to
            # elapsed-time proportion from the trips, then index spacing
            mins = rep_minutes(d)
            coords = []
            for n in names:
                g = geocode_name(n)
                coords.append(g)
            if d.get('kms'):
                # a stop another route already placed keeps that place, and is trusted
                keyed = [re.sub(r'\s+', ' ', n.upper().strip()) for n in names]
                coords = [dict(stops_out[k], precision='override') if stops_out.get(k) else c for k, c in zip(keyed, coords)]
                coords = km_vet(names, coords, kms, mins)
            for i, (n, c) in enumerate(zip(names, coords)):
                if c is None:
                    coords[i] = interpolate(i, coords, kms, mins)
            if d.get('kms'):
                # a stop km vetting dropped and nothing could interpolate keeps its geocode
                coords = [c if c is not None else town_fallback(n) for n, c in zip(names, coords)]
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
