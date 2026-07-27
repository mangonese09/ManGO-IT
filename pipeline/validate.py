# ── STAGE 6: VALIDATE ──
# Structural validation of the emitted GTFS. A feed that fails never ships.
# (The MobilityData canonical validator is Java; run it in addition wherever
# Java exists. These checks are the CI gate.)
import csv, io, math, os, re, sys, zipfile
from datetime import date

sys.path.insert(0, os.path.dirname(__file__))
import emit_gtfs
from assemble import classify_service

SICILY = dict(latMin=36.5, latMax=38.9, lonMin=11.9, lonMax=15.8)


def haversine_km(a, b):
    R = 6371.0
    p = math.pi / 180
    x = math.sin((b[0] - a[0]) * p / 2) ** 2 + \
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


def calendar_assertions():
    """Named-date semantics pinned down (Ferragosto, Easter Monday, Saturdays,
    school breaks). Catching a feriale/sabato mixup here beats every Saturday
    itinerary being wrong."""
    errs = []
    fer = set(emit_gtfs.service_dates({'days': 'mon-sat', 'school': None, 'season': None}))
    fest = set(emit_gtfs.service_dates({'days': 'sun-holidays', 'school': None, 'season': None}))
    mf = set(emit_gtfs.service_dates({'days': 'mon-fri', 'school': None, 'season': None}))
    daily = set(emit_gtfs.service_dates({'days': 'daily', 'school': None, 'season': None}))
    sch = set(emit_gtfs.service_dates({'days': 'mon-sat', 'school': 'school-days-only', 'season': None}))
    ferragosto, pasquetta = date(2026, 8, 15), date(2027, 3, 29)
    sat, tue = date(2026, 10, 3), date(2026, 10, 6)
    if ferragosto in fer: errs.append('Ferragosto runs on a feriale service')
    if ferragosto not in fest: errs.append('Ferragosto missing from festivo service')
    if pasquetta in mf: errs.append('Easter Monday runs on a mon-fri service')
    if sat not in fer: errs.append('ordinary Saturday missing from feriale (mon-sat)')
    if sat in mf: errs.append('Saturday present in mon-fri service')
    if ferragosto not in daily: errs.append('daily service missing Ferragosto')
    if date(2026, 12, 28) in sch: errs.append('school service runs during Christmas break')
    if tue not in sch: errs.append('school service missing an ordinary school Tuesday')
    if classify_service('FERIALE')['days'] != 'mon-sat': errs.append('FERIALE != mon-sat')
    if classify_service('FERIALE escluso sabato')['days'] != 'mon-fri': errs.append('escluso sabato != mon-fri')
    if classify_service('FERIALEscinolpaesrtiiocodo')['school'] != 'school-days-only':
        errs.append('interleaved scolastico label not decoded')
    return errs


def rows(z, name):
    with z.open(name) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8')))


def main(path):
    errors, warnings = [], []
    z = zipfile.ZipFile(path)
    need = {'agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar_dates.txt', 'feed_info.txt'}
    missing = need - set(z.namelist())
    if missing: errors.append(f'missing files: {missing}')

    ag = rows(z, 'agency.txt'); stops = rows(z, 'stops.txt'); routes = rows(z, 'routes.txt')
    trips = rows(z, 'trips.txt'); st = rows(z, 'stop_times.txt'); cal = rows(z, 'calendar_dates.txt')

    aids = {a['agency_id'] for a in ag}
    sids = {s['stop_id'] for s in stops}
    rids = {r['route_id'] for r in routes}
    tids = {t['trip_id'] for t in trips}
    svcs = {c['service_id'] for c in cal}

    if len(sids) != len(stops): errors.append('duplicate stop_ids')
    if len(tids) != len(trips): errors.append('duplicate trip_ids')

    for r in routes:
        if r['agency_id'] not in aids: errors.append(f"route {r['route_id']}: unknown agency")
    for t in trips:
        if t['route_id'] not in rids: errors.append(f"trip {t['trip_id']}: unknown route")
        if t['service_id'] not in svcs: errors.append(f"trip {t['trip_id']}: service {t['service_id']} has no dates")
    for s in stops:
        lat, lon = float(s['stop_lat']), float(s['stop_lon'])
        if not (SICILY['latMin'] <= lat <= SICILY['latMax'] and SICILY['lonMin'] <= lon <= SICILY['lonMax']):
            errors.append(f"stop {s['stop_id']}: outside Sicily bbox ({lat},{lon})")

    by_trip = {}
    for row in st:
        by_trip.setdefault(row['trip_id'], []).append(row)
    for tid in tids:
        seq = by_trip.get(tid, [])
        if len(seq) < 2:
            errors.append(f'trip {tid}: fewer than 2 stop_times'); continue
        seq.sort(key=lambda r: int(r['stop_sequence']))
        prev = -1
        for row in seq:
            if row['stop_id'] not in sids: errors.append(f'trip {tid}: unknown stop {row["stop_id"]}')
            m = re.match(r'^(\d+):(\d+):(\d+)$', row['departure_time'])
            if not m: errors.append(f'trip {tid}: bad time {row["departure_time"]}'); continue
            t = int(m.group(1)) * 3600 + int(m.group(2)) * 60
            if t < prev: errors.append(f'trip {tid}: time goes backwards at seq {row["stop_sequence"]}')
            prev = t
    orphan_stops = sids - {r['stop_id'] for r in st}
    if orphan_stops: warnings.append(f'{len(orphan_stops)} stops unused by any trip')

    # implied-speed plausibility: catches column misalignment and bad geocodes
    import json as _json
    prec_by_name = {}
    try:
        sc = _json.load(open(os.path.join(os.path.dirname(__file__), 'data', 'stop-coords.json'), encoding='utf-8'))
        prec_by_name = {k: v['precision'] for k, v in sc.items() if v}
    except FileNotFoundError:
        pass
    try:
        sc2 = _json.load(open(os.path.join(os.path.dirname(__file__), 'data', 'sais-stop-coords.json'), encoding='utf-8'))
        prec_by_name.update({k: v['precision'] for k, v in sc2.items() if v})
    except FileNotFoundError:
        pass
    precision = {s['stop_id']: prec_by_name.get(re.sub(r'\s+', ' ', s['stop_name'].upper().strip())) for s in stops}
    pos = {s['stop_id']: (float(s['stop_lat']), float(s['stop_lon'])) for s in stops}
    speed_errs, slow_warns = 0, 0
    for tid, seq in by_trip.items():
        seq.sort(key=lambda r: int(r['stop_sequence']))
        for a, b in zip(seq, seq[1:]):
            if a['stop_id'] not in pos or b['stop_id'] not in pos: continue
            km = haversine_km(pos[a['stop_id']], pos[b['stop_id']])
            ta = int(a['departure_time'][:2]) * 60 + int(a['departure_time'][3:5])
            tb = int(b['arrival_time'][:2]) * 60 + int(b['arrival_time'][3:5])
            dt = tb - ta
            if dt <= 0 and km > 3:
                speed_errs += 1
                if speed_errs <= 8: errors.append(f'trip {tid}: {km:.0f}km in {dt}min ({a["stop_id"]}→{b["stop_id"]})')
                continue
            if dt > 0:
                v = km / (dt / 60)
                if v > 110:
                    speed_errs += 1
                    if speed_errs <= 8: errors.append(f'trip {tid}: implied {v:.0f} km/h over {km:.0f}km')
                elif v < 5 and km > 2.5:
                    # floor: duplicated/stalled time cells. Hard-fail only when both
                    # ends have street-precision coords; centroid pins get a warning
                    # tier since town-level geometry legitimately compresses distance.
                    # 'exact' (API-sourced) ends stay in the warning tier: slow legs
                    # there are schedule truth (school circuits, long dwells), not
                    # the stalled-PDF-cell artifact this gate exists to catch.
                    if precision.get(a['stop_id']) == 'street' and precision.get(b['stop_id']) == 'street':
                        speed_errs += 1
                        if speed_errs <= 8: errors.append(f'trip {tid}: implied {v:.1f} km/h over {km:.1f}km (street-precision ends)')
                    else:
                        slow_warns += 1
    if speed_errs > 8: errors.append(f'... plus {speed_errs - 8} more speed violations')
    if slow_warns: warnings.append(f'{slow_warns} suspiciously slow segments (<5 km/h over >2.5km) at centroid/interpolated precision')

    # wrong-province gate (audit P0.3): a stop whose name claims a major city
    # must sit near that city. Catches homonym geocodes that survive the speed
    # gate on slow legs (CATANIA piazza Giovanni XXIII shipped 30 km inland).
    CITY_KM = 25
    CITIES = {
        'PALERMO': (38.116, 13.362), 'CATANIA': (37.507, 15.083),
        'MESSINA': (38.193, 15.554), 'SIRACUSA': (37.069, 15.283),
        'AGRIGENTO': (37.311, 13.577), 'TRAPANI': (38.017, 12.514),
        'RAGUSA': (36.925, 14.731), 'ENNA': (37.567, 14.279),
        'CALTANISSETTA': (37.490, 14.063), 'GELA': (37.073, 14.240),
        'MODICA': (36.859, 14.761), 'MILAZZO': (38.221, 15.240),
    }
    city_errs = 0
    for s_ in stops:
        up = s_['stop_name'].upper()
        if 'AEROPORTO' in up or 'PUNTA RAISI' in up:
            continue  # airports legitimately sit outside their city
        for city, c in CITIES.items():
            if re.match(rf'{city}\b', up):
                d_ = haversine_km((float(s_['stop_lat']), float(s_['stop_lon'])), c)
                if d_ > CITY_KM:
                    city_errs += 1
                    if city_errs <= 8:
                        errors.append(f"stop {s_['stop_id']} \"{s_['stop_name']}\" is {d_:.0f}km from {city} (wrong-province geocode?)")
                break
    if city_errs > 8: errors.append(f'... plus {city_errs - 8} more wrong-province stops')

    errors += calendar_assertions()

    print(f'trips={len(trips)} stops={len(stops)} stop_times={len(st)} services={len(svcs)}')
    for w in warnings: print('WARN:', w)
    if errors:
        print(f'FAIL — {len(errors)} errors:')
        for e in errors[:30]: print('  ', e)
        sys.exit(1)
    print('PASS — structural validation clean')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'pipeline/dist/sicily-coaches.gtfs.zip')
