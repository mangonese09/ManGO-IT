"""Audit-only earliest-arrival router (Connection Scan Algorithm) over the
emitted GTFS zip. This is the "with-feed" baseline for the Phase 1A query
matrix: it approximates what any competent router (MOTIS post-ingestion)
can extract from our own feed alone. Not a product component.

Semantics honored from the feed:
- calendar_dates-only services (exception_type 1 adds, 2 removes)
- pickup_type=1 forbids boarding, drop_off_type=1 forbids alighting
  (the divieto prescriptions are expressed this way — dropping them
  would fabricate journeys AST is legally forbidden to sell)
- times may exceed 24:00 (next-day rollover)

Model choices (documented in 02-query-matrix.md):
- board/alight attachment: stops within ATTACH_M of the query point,
  walk at WALK_MPS from the point (mirrors tuned maxMatchingDistance=600)
- transfers: same stop 180 s; walk links between stops < XFER_M apart,
  max(120 s, dist/WALK_MPS). XFER_M=800 approximates MOTIS's default
  max_footpath_length (~10 min street walk) with straight-line distance.
  NOTE: /api/direct's twoLegSearch allows 1500 m transfers — the CSA is
  deliberately the more conservative model.
"""
import csv
import io
import math
import sys
import zipfile
from collections import defaultdict

ATTACH_M = 600
XFER_M = 800
WALK_MPS = 1.2
MIN_XFER_S = 180


def _hav(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _secs(hms):
    h, m, s = hms.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)


def _fmt(sec):
    sec = int(sec)
    d, rem = divmod(sec, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    tag = '+1d' if d else ''
    return f'{h:02d}:{m:02d}{tag}'


class Network:
    def __init__(self, zip_path):
        z = zipfile.ZipFile(zip_path)

        def rows(name):
            return csv.DictReader(io.TextIOWrapper(z.open(name), 'utf-8-sig'))

        self.stops = {}          # stop_id -> (lat, lon, name)
        for r in rows('stops.txt'):
            self.stops[r['stop_id']] = (float(r['stop_lat']), float(r['stop_lon']), r['stop_name'])

        agencies = {r['agency_id']: r['agency_name'] for r in rows('agency.txt')}
        self.routes = {}         # route_id -> (long_name, agency_name)
        for r in rows('routes.txt'):
            self.routes[r['route_id']] = (r['route_long_name'] or r['route_short_name'],
                                          agencies.get(r['agency_id'], r['agency_id']))

        self.trip_route = {}
        for r in rows('trips.txt'):
            self.trip_route[r['trip_id']] = (r['route_id'], r['service_id'])

        self.service_dates = defaultdict(set)   # date 'YYYYMMDD' -> {service_id}
        removed = defaultdict(set)
        for r in rows('calendar_dates.txt'):
            if r['exception_type'] == '1':
                self.service_dates[r['date']].add(r['service_id'])
            else:
                removed[r['date']].add(r['service_id'])
        for d, svcs in removed.items():
            self.service_dates[d] -= svcs

        # per-trip ordered stop_times
        by_trip = defaultdict(list)
        for r in rows('stop_times.txt'):
            by_trip[r['trip_id']].append((
                int(r['stop_sequence']), _secs(r['arrival_time']), _secs(r['departure_time']),
                r['stop_id'], r.get('pickup_type', '0') == '1', r.get('drop_off_type', '0') == '1'))
        self.trip_stops = {}
        for tid, lst in by_trip.items():
            lst.sort()
            self.trip_stops[tid] = lst

        # walk links via spatial hash (~300 m cells)
        cell = defaultdict(list)
        for sid, (lat, lon, _n) in self.stops.items():
            cell[(int(lat * 100), int(lon * 100))].append(sid)
        self.footpaths = defaultdict(list)      # stop -> [(stop2, secs)]
        for (cy, cx), ids in cell.items():
            near = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    near.extend(cell.get((cy + dy, cx + dx), ()))
            for sid in ids:
                la, lo, _ = self.stops[sid]
                for oid in near:
                    if oid == sid:
                        continue
                    d = _hav(la, lo, *self.stops[oid][:2])
                    if d <= XFER_M:
                        self.footpaths[sid].append((oid, max(120, int(d / WALK_MPS))))

    def connections_for(self, date):
        """Sorted connection array for one service date (includes prior-day
        trips rolling past midnight is NOT needed for an 08:00+ audit query)."""
        svcs = self.service_dates.get(date, set())
        conns = []
        for tid, (rid, svc) in self.trip_route.items():
            if svc not in svcs:
                continue
            st = self.trip_stops[tid]
            for i in range(len(st) - 1):
                _, _arr, dep, sid, no_pick, _nd = st[i]
                _, arr2, _dep2, sid2, _np2, no_drop = st[i + 1]
                if arr2 < dep:
                    continue  # non-monotonic guard; validate.py should prevent this
                conns.append((dep, arr2, sid, sid2, tid, i, no_pick, no_drop))
        conns.sort()
        return conns

    def near_stops(self, lat, lon, radius=ATTACH_M):
        out = []
        for sid, (la, lo, _n) in self.stops.items():
            d = _hav(lat, lon, la, lo)
            if d <= radius:
                out.append((sid, int(d / WALK_MPS)))
        return out

    def query(self, from_ll, to_ll, date, dep_after_s):
        """Earliest-arrival journey. Returns dict or None."""
        conns = self.connections_for(date)
        src = self.near_stops(*from_ll)
        dst = dict(self.near_stops(*to_ll))
        if not src or not dst:
            return None

        INF = float('inf')
        arr = defaultdict(lambda: INF)      # stop -> earliest arrival
        via = {}                            # stop -> ('conn', conn) | ('walk', from_stop, secs)
        on_trip = {}                        # trip_id -> boarding conn (reachable)
        for sid, walk in src:
            arr[sid] = dep_after_s + walk
            via[sid] = ('origin', walk)
            for oid, w2 in self.footpaths[sid]:
                if dep_after_s + walk + w2 < arr[oid]:
                    arr[oid] = dep_after_s + walk + w2
                    via[oid] = ('walk', sid, w2)

        best_arr, best_stop = INF, None
        for c in conns:
            dep, arrv, s1, s2, tid, _i, no_pick, no_drop = c
            if dep < dep_after_s:
                continue
            if best_arr < dep:
                break
            reachable = tid in on_trip
            if not reachable and not no_pick:
                need = arr[s1] + (0 if via.get(s1, ('',))[0] in ('origin', 'walk') else MIN_XFER_S)
                if need <= dep:
                    reachable = True
                    on_trip[tid] = c
            if not reachable:
                continue
            if tid not in on_trip:
                on_trip[tid] = c
            if not no_drop and arrv < arr[s2]:
                arr[s2] = arrv
                via[s2] = ('conn', c, on_trip[tid])
                for oid, w in self.footpaths[s2]:
                    if arrv + w < arr[oid] and via.get(oid, ('',))[0] != 'conn':
                        arr[oid] = arrv + w
                        via[oid] = ('walk', s2, w)
                if s2 in dst and arrv + dst[s2] < best_arr:
                    best_arr = arrv + dst[s2]
                    best_stop = s2

        if best_stop is None:
            return None
        # unwind legs
        legs = []
        cur = best_stop
        while via[cur][0] != 'origin':
            kind = via[cur][0]
            if kind == 'walk':
                cur = via[cur][1]
                continue
            _k, c, board = via[cur]
            tid = c[4]
            rid = self.trip_route[tid][0]
            rname, agency = self.routes[rid]
            legs.append({
                'route': rname, 'agency': agency,
                'board': self.stops[board[2]][2], 'board_t': _fmt(board[0]),
                'alight': self.stops[c[3]][2], 'alight_t': _fmt(c[1]),
            })
            cur = board[2]
        legs.reverse()
        if not legs:
            return None
        return {
            'dep': legs[0]['board_t'], 'arr': legs[-1]['alight_t'],
            'arr_s': best_arr, 'dep_s': _secs(legs[0]['board_t'][:5] + ':00'),
            'transfers': len(legs) - 1, 'legs': legs,
        }

    def departures(self, from_ll, to_ll, date, start_h=5, end_h=21):
        """Distinct viable departures across the day (EA query each hour,
        deduped by first-leg boarding)."""
        seen, out = set(), []
        for h in range(start_h, end_h):
            j = self.query(from_ll, to_ll, date, h * 3600)
            if not j:
                continue
            key = (j['legs'][0]['route'], j['dep'])
            if key not in seen:
                seen.add(key)
                out.append(j)
        return out


if __name__ == '__main__':
    net = Network(sys.argv[1] if len(sys.argv) > 1 else 'pipeline/dist/sicily-coaches.gtfs.zip')
    # sanity: Raffadali (P.zza Voltano) -> Catania on a summer weekday
    raff = (37.404053, 13.532076)
    ct = (37.510, 15.083)
    j = net.query(raff, ct, '20260805', 6 * 3600)
    print('Raffadali->Catania Wed 8/5 dep>=06:00:', j and (j['dep'], j['arr'], j['transfers']))
    if j:
        for leg in j['legs']:
            print('  ', leg['agency'], '|', leg['route'], '|', leg['board'], leg['board_t'], '->', leg['alight'], leg['alight_t'])
