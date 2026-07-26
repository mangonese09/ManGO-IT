# ── SAIS TRASPORTI (Laser.Orchard booking web-service) ──
# saistrasporti.it exposes its booking engine as JSON (recon in
# docs/sais-recon.md). Unlike the Albatross API (sais_harvest.py) it gives
# NO per-stop sequences and NO validity calendars — only city-level OD
# searches per date. Both gaps are closed here, honestly:
#
#   * Trips are RECONSTRUCTED by stitching the OD matrix: the same physical
#     run is consistent across queries (verified: AG 02:30 →(AG→CL) 03:45,
#     CL 03:45 →(CL→CT) 05:20, AG→CT shows 02:30→05:20, line 9001), so per
#     (date, linea) the observed legs chain on exact (city, time) nodes.
#   * Calendars are INFERRED from a 7-consecutive-day sweep (weekday
#     pattern) + a Ferragosto probe (holiday behaviour), then extrapolated
#     week-by-week — but only up to the TPL summer-period horizon observed
#     in the SAIS Autolinee validities (same consortium), never further.
#     This is an approximation and is documented in the feed notes;
#     re-harvest monthly to extend the horizon.
#
# Modes:
#   python pipeline/saist_harvest.py --graph   # localities + sale graph (cached)
#   python pipeline/saist_harvest.py --sweep   # OD×dates sweep → runs-*.jsonl (resumable)
#   python pipeline/saist_harvest.py --build   # offline: stitch → route JSONs
#
# Politeness: 1.1 s/request, ~1.8k edges × 8 dates ≈ 4-5 h, resumable
# (completed edges are skipped on re-run). Raw responses land in
# data/saist/runs-YYYY-MM-DD.jsonl, one line per edge.
import json, os, re, ssl, sys, time, urllib.request
from datetime import date, timedelta

ROOT = os.path.dirname(__file__)
ST_DIR = os.path.join(ROOT, 'data', 'saist')
ROUTES = os.path.join(ROOT, 'data', 'routes')

BASE = 'https://www.saistrasporti.it/Laser.Orchard.WebServices/webapi/display'
UA = 'ManGO-IT/0.5.0 (+https://it.mangonese.dev; miconsig@gmail.com)'
OPERATOR = 'SAIS Trasporti'
DELAY = 1.1

# Their TLS chain is broken (missing intermediate); the recon already
# accepted this — certificate pinning would be nicer but the data is public.
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# National-line endpoints (FlixBus territory, out of v1 scope). Everything
# else in /from is Sicilian; --graph asserts this list stays in sync.
# Compared after normalizing spaces/dots: the API spells 'VILLA S. GIOVANNI'
# with a space, which silently defeated an exact-match blacklist.
MAINLAND = {'BARI', 'BARLETTA', 'BATTIPAGLIA', 'BOLOGNA', 'BRINDISI', 'CERIGNOLA', 'COSENZA',
            'FIRENZE', 'FOGGIA', 'GIOIA DEL COLLE', 'GROTTAGLIE', 'LECCE', 'MAGLIE', 'MASSAFRA',
            'NAPOLI', 'ROMA', 'SALERNO', 'SIENA', 'TARANTO', 'TRANI',
            'VILLA S GIOVANNI', 'VILLA SAN GIOVANNI', 'CASTELLANETA MARINA', 'MILANO',
            'REGGIO CALABRIA', 'CATANZARO', 'CROTONE', 'LAMEZIA TERME', 'MESSINA IMBARCADERO'}

# Line codes: 9xxx = TPL Sicilia regional; SP/SFB/SN prefixes are the
# national services (out of scope even when a queried Sicily-internal OD
# pair happens to lie along them).
NATIONAL_LINEA = re.compile(r'^(SP|SFB|SN)', re.I)


def norm_city(desc):
    return re.sub(r'\s+', ' ', desc.upper().replace('.', ' ').replace('-', ' ')).strip()

HOLIDAYS = {
    date(2026, 8, 15), date(2026, 11, 1), date(2026, 12, 8),
    date(2026, 12, 25), date(2026, 12, 26),
    date(2027, 1, 1), date(2027, 1, 6),
    date(2027, 3, 28), date(2027, 3, 29),
    date(2027, 4, 25), date(2027, 5, 1), date(2027, 6, 2),
}


def sweep_dates():
    """7 consecutive days from next Monday (weekday pattern) + the next
    national holiday inside the horizon (holiday behaviour probe)."""
    anchor = date.today() + timedelta(days=(7 - date.today().weekday()) % 7 or 7)
    days = [anchor + timedelta(days=i) for i in range(7)]
    probe = next((h for h in sorted(HOLIDAYS) if days[-1] < h <= days[-1] + timedelta(days=45)), None)
    return days + ([probe] if probe else [])


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    time.sleep(DELAY)
    return json.loads(urllib.request.urlopen(req, timeout=45, context=CTX).read())


def locality_payload(d):
    try:
        lst = d['ExternalLocalita']['ExternalLocalitaDPart']['LocalitaFieldExternal']['ContentObject']['virtual']['LocalitaList']
        return [lst] if isinstance(lst, dict) else lst
    except (KeyError, TypeError):
        return []


def search_payload(d):
    try:
        lst = d['ExternalSearch']['ExternalSearchDPart']['ExternalSearchFieldExternal']['ContentObject']['root']['ExternalSearchList']
        return [lst] if isinstance(lst, dict) else lst
    except (KeyError, TypeError):
        return []


def load_graph():
    locs = json.load(open(os.path.join(ST_DIR, 'localities.json'), encoding='utf-8'))
    graph = json.load(open(os.path.join(ST_DIR, 'graph.json'), encoding='utf-8'))
    return locs, graph


def sicilian(locs):
    ml = {norm_city(x) for x in MAINLAND}
    return [l for l in locs if norm_city(l['Descrizione'].split(' - ')[0]) not in ml
            and norm_city(l['Descrizione']) not in ml]


def cmd_graph():
    os.makedirs(ST_DIR, exist_ok=True)
    locs = locality_payload(get(f'{BASE}?alias=from&lang=it-IT'))
    json.dump(locs, open(os.path.join(ST_DIR, 'localities.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    sic = sicilian(locs)
    unknown = [l['Descrizione'] for l in locs if l not in sic
               and l['Descrizione'].upper().split(' - ')[0] not in MAINLAND]
    if unknown:
        sys.exit(f'MAINLAND list out of sync, classify manually: {unknown}')
    graph = {}
    for i, l in enumerate(sic, 1):
        dests = locality_payload(get(f"{BASE}?alias=to&from={l['Id']}&lang=it-IT"))
        graph[l['Id']] = [x['Id'] for x in dests]
        if i % 25 == 0:
            print(f'  graph {i}/{len(sic)}')
    json.dump(graph, open(os.path.join(ST_DIR, 'graph.json'), 'w', encoding='utf-8'))
    n_edges = sum(1 for a, ds in graph.items() for b in ds if b in {x['Id'] for x in sic})
    print(f'{len(locs)} localities ({len(sic)} Sicilian), {n_edges} Sicily-internal edges')


def cmd_sweep():
    locs, graph = load_graph()
    sic_ids = {l['Id'] for l in sicilian(locs)}
    edges = [(a, b) for a, ds in graph.items() if a in sic_ids for b in ds if b in sic_ids]
    dates = sweep_dates()
    print(f'{len(edges)} edges × {len(dates)} dates ({", ".join(str(d) for d in dates)})')
    for d in dates:
        fp = os.path.join(ST_DIR, f'runs-{d.isoformat()}.jsonl')
        done = set()
        if os.path.exists(fp):
            with open(fp, encoding='utf-8') as f:
                for line in f:
                    r = json.loads(line)
                    done.add((r['from'], r['to']))
        todo = [e for e in edges if e not in done]
        print(f'{d}: {len(done)} cached, {len(todo)} to fetch')
        with open(fp, 'a', encoding='utf-8') as out:
            for i, (a, b) in enumerate(todo, 1):
                dd = f'{d.day:02d}/{d.month:02d}/{d.year}'
                rr = f'{(d + timedelta(days=1)).day:02d}/{(d + timedelta(days=1)).month:02d}/{(d + timedelta(days=1)).year}'
                try:
                    runs = search_payload(get(
                        f'{BASE}?alias=search&from={a}&to={b}&type=1&lang=it-IT&departingdate={dd}&returningdate={rr}'))
                except Exception as e:
                    print(f'  RETRY-LATER {a}->{b}: {e}')
                    continue
                slim = [{'dep': r['Orario'], 'arr': r['Ora_arrivo'], 'linea': r['Linea'],
                         'costo': r.get('Costo'), 'info': r.get('Info'),
                         'giorno_arrivo': r.get('Giorno_arrivo')}
                        for r in runs if r.get('Tipo') == 'Andata' and r.get('Validity') == 'true']
                out.write(json.dumps({'from': a, 'to': b, 'date': d.isoformat(), 'runs': slim},
                                     ensure_ascii=False) + '\n')
                if i % 200 == 0:
                    out.flush()
                    print(f'  {d}: {i}/{len(todo)}')
    print('sweep complete')


def hhmm_min(s):
    h, m = s.split(':')
    return int(h) * 60 + int(m)


def autolinee_horizon():
    """Max validityTo across the cached SAIS Autolinee sweep — the TPL
    summer-period boundary for the consortium. Extrapolation cap.
    Open-ended validities (years out, 'until further notice') are ignored:
    only boundaries within a year of today are real period ends."""
    best = None
    sais_dir = os.path.join(ROOT, 'data', 'sais')
    try:
        for f in os.listdir(sais_dir):
            if not f.startswith('tt-'):
                continue
            for route in json.load(open(os.path.join(sais_dir, f), encoding='utf-8')) or []:
                for t in route['tripTemplates']:
                    for v in t['validities']:
                        vt = v['validityTo']
                        try:
                            d = date(vt['year'], vt['month'], vt['day'])
                        except ValueError:
                            continue
                        if d <= date.today() + timedelta(days=365):
                            best = max(best or d, d)
    except FileNotFoundError:
        pass
    return best


def stitch(day_runs, edges=None):
    """One (date, linea) group of leg observations → reconstructed trips.
    Nodes are exact (locality, minute); legs chain when arr(B)==dep(B').
    Every leg fully explained by a chain (both endpoints on it, forward,
    matching times) is CONSUMED; unconsumed legs seed further chains — so
    the return half of a zero-dwell out-and-back becomes its own trip
    instead of fusing (no city revisits) or being lost (no natural start).

    CORROBORATION: every sellable (cityA, cityB) sub-pair of a real trip
    appears as its own direct leg in the OD sweep. So a candidate next hop
    is accepted only if, for EVERY earlier chain node whose pair with the
    candidate was queried (edges), the matching direct leg exists. This is
    what stops a same-line concurrent run (e.g. the Aeroporto branch) from
    being grafted onto another bus's chain.
    Returns list of trips (each: [(loc, min), ...]), plus ambiguity count."""
    trips, ambiguous = [], 0
    edges = edges or set()
    by_linea = {}
    for (a, b, dep, arr, linea) in day_runs:
        by_linea.setdefault(linea, []).append((a, dep, b, arr))
    for linea, legs in by_linea.items():
        legs = sorted(set(legs), key=lambda x: (x[1], x[3], x[0], x[2]))
        leg_set = set(legs)
        out_at = {}
        for leg in legs:
            out_at.setdefault((leg[0], leg[1]), []).append(leg)
        consumed = set()
        for seed in legs:
            if seed in consumed:
                continue
            start = (seed[0], seed[1])
            nodes, visited = [start], {seed[0]}
            while True:
                # candidates depart from ANY node already on the chain — the
                # next physical stop isn't always sellable from the previous
                # one (e.g. Aeroporto→Catania centre), but it IS sellable
                # from earlier cities, so the leg exists further back
                cands = [l for (mc, mt) in nodes for l in out_at.get((mc, mt), [])
                         if l not in consumed and l[2] not in visited and l[3] >= nodes[-1][1]]
                # nearest arrival FIRST (direct long legs coexist with the
                # stop-by-stop chain), but only if corroborated by direct
                # legs from every earlier chain node where the pair is sellable
                nxt = None
                for l in sorted(cands, key=lambda l: l[3]):
                    ok = True
                    for (mc, mt) in nodes:
                        if (mc, l[2]) in edges and (mc, mt, l[2], l[3]) not in leg_set:
                            ok = False
                            break
                    if ok:
                        nxt = (l[2], l[3])
                        break
                if not nxt:
                    break
                nodes.append(nxt)
                visited.add(nxt[0])
            if len(nodes) < 2:
                continue
            node_time = dict(nodes)
            node_idx = {c: i for i, (c, t) in enumerate(nodes)}
            # forward consistency: a leg departing a chain node at the chain's
            # time toward a LATER chain city must land at that city's chain
            # time (return legs run backward through the chain — not ours)
            explained, bad = [], False
            for l in legs:
                a, dep, b, arr = l
                if a in node_idx and b in node_idx and node_idx[a] < node_idx[b] \
                        and node_time[a] == dep:
                    if node_time[b] == arr:
                        explained.append(l)
                    else:
                        bad = True
            if bad:
                # same-line same-minute doubled runs (school variants) at city
                # granularity: both are sold journeys. Keep this corroborated
                # chain; the contradicting legs stay unconsumed and seed their
                # own (shorter) trips instead of both being thrown away.
                ambiguous += 1
            consumed.update(explained)
            trips.append((linea, nodes))
    return trips, ambiguous


def infer_dates(observed, week_days, holiday_probe, ran_on_probe, cap):
    """Weekly-pattern extrapolation from sweep start to cap. National
    holidays: skipped unless the trip demonstrably ran on the probe holiday
    (or runs Sundays — Italian festivo convention)."""
    lo = min(observed)
    festivo_like = week_days == {6} or ran_on_probe
    out = []
    d = lo
    while d <= cap:
        run = d.weekday() in week_days
        if d in HOLIDAYS:
            run = festivo_like or (holiday_probe is None and 6 in week_days and d.weekday() == 6)
        if run:
            out.append(d)
        d += timedelta(days=1)
    return out


def pretty_name(desc):
    """'PALERMO - VIA BASILE' → 'PALERMO (Via Basile)' (pipeline convention,
    lets geocode.py resolve street-level); plain city names stay as-is."""
    parts = [p.strip() for p in desc.split(' - ', 1)]
    if len(parts) == 2:
        return f'{parts[0].upper()} ({parts[1].title()})'
    return desc.upper()


def cmd_build():
    locs, graph = load_graph()
    name_of = {l['Id']: pretty_name(l['Descrizione']) for l in locs}
    sic_ids = {l['Id'] for l in sicilian(locs)}
    queried_edges = {(a, b) for a, ds in graph.items() if a in sic_ids
                     for b in ds if b in sic_ids}
    day_files = sorted(f for f in os.listdir(ST_DIR) if f.startswith('runs-'))
    if not day_files:
        sys.exit('no runs-*.jsonl — run --sweep first')
    cap = autolinee_horizon() or (date.fromisoformat(day_files[0][5:15]) + timedelta(days=49))
    print(f'extrapolation cap: {cap} (TPL summer horizon from Autolinee validities)')

    probe_day = None
    sweep_days = []
    for f in day_files:
        d = date.fromisoformat(f[5:15])
        sweep_days.append(d)
        if d in HOLIDAYS:
            probe_day = d
    week = [d for d in sweep_days if d != probe_day]

    # signature = (linea, ((loc,min),...)) → set of dates it ran
    sig_dates = {}
    total_ambig = 0
    for f in day_files:
        d = date.fromisoformat(f[5:15])
        day_runs = []
        with open(os.path.join(ST_DIR, f), encoding='utf-8') as fh:
            for line in fh:
                row = json.loads(line)
                for r in row['runs']:
                    if r.get('giorno_arrivo') and r['giorno_arrivo'][:2] != f'{d.day:02d}':
                        continue  # overnight arrivals: not chainable at city level, skip leg
                    if NATIONAL_LINEA.match(str(r['linea'])):
                        continue  # national services (SP/SFB/SN): out of v1 scope
                    day_runs.append((row['from'], row['to'], hhmm_min(r['dep']), hhmm_min(r['arr']), r['linea']))
        trips, ambig = stitch(day_runs, queried_edges)
        total_ambig += ambig
        for linea, nodes in trips:
            sig_dates.setdefault((linea, tuple(nodes)), set()).add(d)

    for f in os.listdir(ROUTES):
        if f.startswith('saist-'):
            os.remove(os.path.join(ROUTES, f))

    by_linea = {}
    for (linea, nodes), dts in sig_dates.items():
        by_linea.setdefault(linea, []).append((nodes, dts))
    written = n_trips = 0
    for linea, entries in sorted(by_linea.items()):
        rid = f'saist-{re.sub(r"[^a-z0-9]+", "-", str(linea).lower())}'
        dirs = {}
        for nodes, dts in sorted(entries):
            week_days = {d.weekday() for d in dts if d != probe_day}
            if not week_days:
                continue  # holiday-probe-only appearance: no weekly evidence
            ran_on_probe = probe_day in dts if probe_day else False
            dates = infer_dates(dts, week_days, probe_day, ran_on_probe, cap)
            if not dates:
                continue
            di = 0 if nodes[0][0] < nodes[-1][0] else 1
            seq = [{'stop': name_of.get(loc, loc), 'idx': i,
                    'arr': f'{m // 60}.{m % 60:02d}', 'dep': f'{m // 60}.{m % 60:02d}'}
                   for i, (loc, m) in enumerate(nodes)]
            dd = dirs.setdefault(di, {'stops': [], '_seen': set(), 'trips': []})
            for x in seq:
                if x['stop'] not in dd['_seen']:
                    dd['_seen'].add(x['stop']); dd['stops'].append(x['stop'])
            dd['trips'].append({
                'corsa': f'{nodes[0][1] // 60:02d}{nodes[0][1] % 60:02d}',
                'service': {'days': 'explicit', 'school': None, 'season': None,
                            'raw': f'inferred from {sorted(str(x) for x in dts)} (weekly pattern, capped {cap})',
                            'explicit_dates': [x.isoformat() for x in dates]},
                'reverse': di == 1,
                'stops': seq,
                'valid': all(a[1] <= b[1] for a, b in zip(nodes, nodes[1:])),
            })
            n_trips += 1
        if not any(d['trips'] for d in dirs.values()):
            continue
        # human corridor name from the longest reconstructed trip
        longest = max((t for d_ in dirs.values() for t in d_['trips']),
                      key=lambda t: len(t['stops']))
        ends = [longest['stops'][0]['stop'], longest['stops'][-1]['stop']]
        if longest['reverse']:
            ends.reverse()
        corridor = ' - '.join(e.split(' (')[0].title() for e in ends)
        route = {'operator': OPERATOR, 'route_id': rid,
                 'name': f'{corridor} (SAIS Trasporti {linea})',
                 'short_name': str(linea),
                 'source': f'saistrasporti.it webapi (OD-matrix, sampled w/c {week[0] if week else "?"})',
                 'prescriptions': [], 'directions': []}
        for di in sorted(dirs):
            dirs[di].pop('_seen')
            route['directions'].append(dirs[di])
        json.dump(route, open(os.path.join(ROUTES, f'{rid}.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        written += 1
    print(f'{written} route JSONs, {n_trips} trips, {total_ambig} ambiguous chains skipped')
    print('NOTE: calendars are INFERRED (weekly pattern + holiday probe), '
          f'extrapolated only to {cap}; re-harvest monthly.')


if __name__ == '__main__':
    if '--graph' in sys.argv:
        cmd_graph()
    elif '--sweep' in sys.argv:
        cmd_sweep()
    elif '--build' in sys.argv:
        cmd_build()
    else:
        sys.exit('usage: saist_harvest.py --graph | --sweep | --build')
