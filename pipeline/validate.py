# ── STAGE 6: VALIDATE ──
# Structural validation of the emitted GTFS. A feed that fails never ships.
# (The MobilityData canonical validator is Java; run it in addition wherever
# Java exists. These checks are the CI gate.)
import csv, io, re, sys, zipfile

SICILY = dict(latMin=36.5, latMax=38.9, lonMin=11.9, lonMax=15.8)


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

    print(f'trips={len(trips)} stops={len(stops)} stop_times={len(st)} services={len(svcs)}')
    for w in warnings: print('WARN:', w)
    if errors:
        print(f'FAIL — {len(errors)} errors:')
        for e in errors[:30]: print('  ', e)
        sys.exit(1)
    print('PASS — structural validation clean')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'pipeline/dist/sicily-coaches.gtfs.zip')
