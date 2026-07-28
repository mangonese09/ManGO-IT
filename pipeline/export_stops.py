# ── EXPORT COACH STOPS ──
# stop-coords.json + route stop names → server/coach-stops.json, feeding the
# proxy's autocomplete so coach stops are searchable before Transitous ingests.
# Applies the same stop consolidation as emit_gtfs (audit F-2) so boards and
# autocomplete don't show three spellings of one pole.
#
# Review R-26: it now also applies the same TRIP gates as emit_gtfs, via
# gates.py. It used to apply none of them, so the app served 906 trips the
# validated feed had already rejected.
import collections, json, math, os, re

from gates import is_junk_stop, speed_violation, span_violation
from stopnorm import canon_key, display_score, sig_tokens, MERGE_M

ROOT = os.path.dirname(__file__)


def hav_m(a, b):
    p = math.pi / 180
    return 2 * 6371000 * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2 +
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def to_min(t):
    h, m = re.split(r'[.:]', t)
    return int(h) * 60 + int(m)


# Timetable sheets mark terminal rows with a lone "a." (arrivo) or "p."
# (partenza). Those fragments carry no significant tokens, so a naive
# most-generic rule crowns 'SIRACUSA a.' over plain 'SIRACUSA'.
_FRAGMENT = re.compile(r'(^|\s)[a-z]\.?\s*$', re.I)


def _frag_penalty(name):
    return 1 if _FRAGMENT.search((name or '').strip()) else 0


def main():
    coords = json.load(open(os.path.join(ROOT, 'data', 'stop-coords.json'), encoding='utf-8'))
    sais_f = os.path.join(ROOT, 'data', 'sais-stop-coords.json')
    if os.path.exists(sais_f):
        coords.update(json.load(open(sais_f, encoding='utf-8')))
    names, order = {}, []
    canon_registry = {}
    trips = []
    dropped = {'junk-collapsed': 0, 'speed': 0, 'span': 0, 'short': 0}
    for f in sorted(os.listdir(os.path.join(ROOT, 'data', 'routes'))):
        r = json.load(open(os.path.join(ROOT, 'data', 'routes', f), encoding='utf-8'))
        for d in r['directions']:
            for t in d['trips']:
                if not t['valid']: continue
                seq, seq_coords = [], []
                prev_min, offset = -1, 0
                for s in t['stops']:
                    # anonymous placeholders carry no location; emit_gtfs has
                    # always dropped them, so they cannot stay here either
                    if is_junk_stop(s['stop']): continue
                    key = re.sub(r'\s+', ' ', s['stop'].upper().strip())
                    c = coords.get(key)
                    if not c: continue
                    if key not in names:
                        ck = canon_key(s['stop'])
                        merged = None
                        for cand in canon_registry.get(ck, []):
                            if hav_m((c['lat'], c['lon']), (cand['lat'], cand['lon'])) <= MERGE_M:
                                merged = cand
                                break
                        if merged:
                            names[key] = merged['i']
                            score = display_score(s['stop'], c.get('precision'))
                            if score > merged['score']:
                                order[merged['i']] = {'n': s['stop'], 'lat': round(c['lat'], 5), 'lon': round(c['lon'], 5)}
                                merged.update(lat=c['lat'], lon=c['lon'], score=score)
                        else:
                            names[key] = len(order)
                            canon_registry.setdefault(ck, []).append({
                                'i': len(order), 'lat': c['lat'], 'lon': c['lon'],
                                'score': display_score(s['stop'], c.get('precision')),
                            })
                            order.append({'n': s['stop'], 'lat': round(c['lat'], 5), 'lon': round(c['lon'], 5)})
                    # unwrap past midnight exactly as emit_gtfs does, or a
                    # legitimate overnight run reads as a backwards leg
                    cur = to_min(s['dep'])
                    if cur < prev_min - 2: offset = 1440
                    prev_min = max(prev_min, cur)
                    seq.append([names[key], cur + offset])
                    seq_coords.append((c['lat'], c['lon']))
                if len(seq) < 2:
                    dropped['short'] += 1
                    continue
                times = [m for _, m in seq]
                if speed_violation(times, seq_coords):
                    dropped['speed'] += 1
                    continue
                if span_violation(times) is not None:
                    dropped['span'] += 1
                    continue
                svc = t['service']
                row = {'r': r['name'][:60], 'op': r['operator'],
                       'd': svc['days'], 'sc': svc['school'],
                       'se': svc['season'], 's': seq}
                if svc.get('explicit_dates'):
                    row['xd'] = svc['explicit_dates']  # exact ISO dates (SAIS/Albatross)
                trips.append(row)

    # coordinate pileups (R-15): 167 clusters of stops share one exact
    # coordinate — 14 of them on the Agrigento centroid alone. stopnorm's
    # name-similarity merge cannot reach these ('Agrigento' vs 'AGRIGENTO
    # (Templi Museo)' vs 'Scala Torregrotta Scala Torregrotta 26.1' share no
    # canon_key), so they ship as distinct stops standing 0 m apart. That is a
    # ROUTING defect before it is a labelling one: zero-distance neighbours
    # fabricate free transfers between places that are kilometres apart, and
    # they flood autocomplete with entries that all resolve to one point.
    #
    # Stops on one coordinate are one stop as far as this dataset can tell, so
    # collapse them. The surviving name is the most GENERIC in the cluster,
    # deliberately inverting display_score: the coordinate is a town centroid,
    # and 'Agrigento' is the only claim it actually supports — 'AGRIGENTO
    # (Archeol. Scuol E Ss 640 Stazione Fs)' asserts a precision we do not have
    # (and is parse damage besides). Every cluster is written to the report so
    # a real geocode can split them back out later.
    visits = collections.Counter(i for t in trips for i, _ in t['s'])
    by_coord = collections.defaultdict(list)
    for i, s in enumerate(order):
        by_coord[(s['lat'], s['lon'])].append(i)
    pile_map, pile_report = {}, []
    for coord, members in by_coord.items():
        if len(members) < 2: continue
        keep = min(members, key=lambda i: (len(sig_tokens(canon_key(order[i]['n']))),
                                           _frag_penalty(order[i]['n']),
                                           -visits[i], len(order[i]['n'])))
        for i in members:
            if i != keep: pile_map[i] = keep
        pile_report.append({
            'lat': coord[0], 'lon': coord[1], 'kept': order[keep]['n'],
            'absorbed': [order[i]['n'] for i in members if i != keep],
        })
    if pile_map:
        for t in trips:
            for st in t['s']:
                st[0] = pile_map.get(st[0], st[0])
            # A cluster visited twice in one trip collapses to consecutive
            # duplicates, which would claim a 0-minute leg. Which time survives
            # matters: sheets split a terminal into an arrival row and a
            # departure row ('SIRACUSA a.' 07:50 / 'SIRACUSA p.' 08:00), and
            # these entries are DEPARTURE times — so a mid-trip dwell keeps the
            # last (you board at 08:00, not 07:50). At the end of the trip
            # there is nothing left to board, so the first time wins and the
            # run is reported arriving when it actually arrives.
            runs = [[t['s'][0]]]
            for st in t['s'][1:]:
                if st[0] == runs[-1][-1][0]:
                    runs[-1].append(st)
                else:
                    runs.append([st])
            t['s'] = [r[0] if k == len(runs) - 1 else r[-1] for k, r in enumerate(runs)]
        trips = [t for t in trips if len(t['s']) >= 2]

    # orphan filter (R-14): a stop is registered the moment it is first seen,
    # while its trip is still under consideration. Gated-out trips therefore
    # leave stops nothing references — favouritable, searchable, and served by
    # nothing. Ship only stops a surviving trip actually visits, and renumber
    # the trip references, which are array indices into this same list.
    used = sorted({i for t in trips for i, _ in t['s']})
    n_orphans = len(order) - len(used)
    remap = {old: new for new, old in enumerate(used)}
    order = [order[i] for i in used]
    for t in trips:
        for st in t['s']:
            st[0] = remap[st[0]]

    json.dump(order, open(os.path.join(ROOT, '..', 'server', 'coach-stops.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(trips, open(os.path.join(ROOT, '..', 'server', 'coach-trips.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    rep_dir = os.path.join(ROOT, 'data', 'reports')
    os.makedirs(rep_dir, exist_ok=True)
    pile_report.sort(key=lambda c: -len(c['absorbed']))
    json.dump(pile_report, open(os.path.join(rep_dir, 'coord-pileups.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print(f'{len(order)} coach stops ({n_orphans} orphans dropped), {len(trips)} trips '
          f'-> server/coach-{{stops,trips}}.json')
    print(f'  gated out: ' + ', '.join(f'{k}={v}' for k, v in dropped.items()))
    print(f'  coordinate pileups: {len(pile_report)} clusters, '
          f'{sum(len(c["absorbed"]) for c in pile_report)} stops absorbed '
          f'-> data/reports/coord-pileups.json')


if __name__ == '__main__':
    main()
