# ── STAGE 3b: ASSEMBLE ──
# Grids → route JSONs (the parse contract): trips with per-stop times,
# direction detection, A./P. merge, service-class classification.
#
# Direction is detected per corsa: first-served-stop time < last-served-stop
# time → reads top-down; otherwise the corsa reads bottom-up (return side of a
# single-table sheet) and the stop order is reversed.
import json, os, re, sys, unicodedata

ROOT = os.path.dirname(__file__)
GRIDS = os.path.join(ROOT, 'data', 'grids')
OUT = os.path.join(ROOT, 'data', 'routes')

TIME_RE = re.compile(r'^\d{1,2}[.:]\d{2}$')
JUNK_ROW = re.compile(r'^(KM\b|FERIALE|FESTIV|L u n|F E R|s c o|p e r|e s c|STAZIONAMENTI)', re.I)


def squash(label):
    s = unicodedata.normalize('NFD', label or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^A-Z0-9/\-]', '', s.upper())


def has_subseq(hay, needle):
    it = iter(hay)
    return all(c in it for c in needle)


def classify_service(label):
    """Label → service descriptor. Interleaved vertical text is handled by
    subsequence matching (the interleave preserves each phrase's letter order)."""
    s = squash(label)
    svc = {'days': 'mon-sat', 'school': None, 'season': None, 'raw': label}
    if 'FESTIV' in s or has_subseq(s, 'DOMENICALE'):
        svc['days'] = 'sun-holidays'
    if has_subseq(s, 'LUN') and has_subseq(s, 'VEN') and 'FESTIV' not in s:
        svc['days'] = 'mon-fri'
    if has_subseq(s, 'ESCLUSOSABATO'):
        svc['days'] = 'mon-fri'
    if has_subseq(s, 'SCOLASTICO') or has_subseq(s, 'SCOLASTICA'):
        if has_subseq(s, 'ESCLUSO') or has_subseq(s, 'NONSCOLASTICO') or has_subseq(s, 'NONPERIODO'):
            svc['school'] = 'holidays-only'
        else:
            svc['school'] = 'school-days-only'
    m = re.search(r'(\d{1,2}/\d{1,2})-(\d{1,2}/\d{1,2})', s)
    if m:
        svc['season'] = {'from': m.group(1), 'to': m.group(2)}
    return svc


def clean_stops(stops):
    out = []
    for s in stops:
        name = re.sub(r'\s+', ' ', s['name']).strip()
        if not name or JUNK_ROW.match(name): continue
        toks = name.split()
        if len(toks) >= 4 and sum(1 for t in toks if len(t) == 1) / len(toks) > 0.4:
            continue  # interleaved label soup, not a stop
        entry = {'name': name, 'times': s['times'], 'km': s.get('km', [])}
        if name.startswith('(') and out:
            prev = out[-1]
            if not prev['times'] and entry['times']:
                prev['name'] += ' ' + name
                prev['times'] = entry['times']
                prev['km'] = prev['km'] or entry['km']
                continue
            if prev['times'] and not entry['times']:
                prev['name'] += ' ' + name
                continue
        out.append(entry)
    # merge A./P. terminal pairs
    merged = []
    for s in out:
        base = re.sub(r'\s+[AP]\.?$', '', s['name'])
        flag = 'A' if re.search(r'\sA\.?$', s['name']) else 'P' if re.search(r'\sP\.?$', s['name']) else None
        if flag and merged and merged[-1].get('base') == base:
            merged[-1][f'times_{flag}'] = s['times']
            continue
        entry = {'name': base, 'base': base, 'times': s['times'], 'km': s['km']}
        if flag:
            entry[f'times_{flag}'] = s['times']
            entry['times'] = {}
        merged.append(entry)
    for s in merged:
        s.pop('base', None)
    return [s for s in merged if s['times'] or s.get('times_A') or s.get('times_P')]


def to_min(t):
    h, m = re.split(r'[.:]', t)
    return int(h) * 60 + int(m)


def build_trips(table):
    stops = clean_stops(table['stops'])
    trips = []
    for c in table['corse']:
        n = c['n']
        seq = []
        for idx, s in enumerate(stops):
            arr = (s.get('times_A') or {}).get(n)
            dep = (s.get('times_P') or {}).get(n) or s['times'].get(n)
            arr = arr if arr and TIME_RE.match(arr) else None
            dep = dep if dep and TIME_RE.match(dep) else None
            if arr or dep:
                seq.append({'stop': s['name'], 'idx': idx,
                            'arr': arr or dep, 'dep': dep or arr})
        if len(seq) < 2: continue
        first, last = to_min(seq[0]['dep']), to_min(seq[-1]['arr'])
        reverse = first > last
        if reverse:
            seq = list(reversed(seq))
            for st in seq:  # bottom-up column: printed arr/dep roles hold
                st['arr'], st['dep'] = st['arr'], st['dep']
        # overnight guard: times must be non-decreasing; allow past-midnight wrap once
        ok, prev, wrapped = True, None, False
        for st in seq:
            t = to_min(st['arr'])
            if prev is not None and t < prev - 2:
                if not wrapped and prev - t > 18 * 60:
                    wrapped = True  # crosses midnight
                else:
                    ok = False; break
            prev = max(prev or 0, t)
        trips.append({'corsa': n, 'service': classify_service(c.get('label', '')),
                      'reverse': reverse, 'stops': seq, 'valid': ok})
    return stops, trips


def assemble_page(op, page_file, meta):
    grid = json.load(open(os.path.join(GRIDS, op, page_file), encoding='utf-8'))
    route = {'operator': meta['agency'], 'route_id': meta['route_id'],
             'name': meta['name'], 'source': f'{op}/{page_file}',
             'prescriptions': [], 'directions': []}
    for t in grid['tables']:
        stops, trips = build_trips(t)
        route['prescriptions'] += t.get('prescriptions', [])
        route['directions'].append({
            'stops': [s['name'] for s in stops],
            'trips': trips,
        })
    return route


def main():
    registry = json.load(open(os.path.join(ROOT, 'seed_routes.json'), encoding='utf-8'))
    os.makedirs(OUT, exist_ok=True)
    report = []
    for entry in registry:
        route = assemble_page(entry['dir'], entry['page'], entry)
        n_trips = sum(len(d['trips']) for d in route['directions'])
        n_valid = sum(1 for d in route['directions'] for t in d['trips'] if t['valid'])
        fn = f"{entry['route_id']}.json"
        with open(os.path.join(OUT, fn), 'w', encoding='utf-8') as f:
            json.dump(route, f, ensure_ascii=False, indent=1)
        report.append(f"{entry['route_id']:24} trips={n_trips:3} valid={n_valid:3}  {entry['name'][:50]}")
    print('\n'.join(report))


if __name__ == '__main__':
    main()
