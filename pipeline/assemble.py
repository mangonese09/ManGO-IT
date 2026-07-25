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


def collapse_doubles(s):
    """'SSaann GGiiuusseeppppee' (overprint-bold) → 'San Giuseppe'."""
    pairs = len(re.findall(r'(.)\1', s))
    if pairs < max(3, len(s) // 5): return s
    out, i = [], 0
    while i < len(s):
        out.append(s[i])
        i += 2 if i + 1 < len(s) and s[i + 1] == s[i] else 1
    return ''.join(out)


def deinterleave(name):
    """Town printed in wide letter-spacing THROUGH the stop text at the same y:
    uppercase single-letter tokens spell the town; the rest is the stop detail."""
    toks = name.split()
    # town letters interleave at every-other token position — find the longest
    # step-2 run of uppercase single-letter tokens
    ups = [i for i, t in enumerate(toks) if len(t) == 1 and t.isupper()]
    best = []
    for start in ups:
        run = [start]
        while run[-1] + 2 in ups: run.append(run[-1] + 2)
        if len(run) > len(best): best = run
    town_idx = set(best) if len(best) >= 4 else set(i for i in ups)
    town = ''.join(toks[i] for i in sorted(town_idx))
    rest = ''.join(t for i, t in enumerate(toks) if i not in town_idx)
    rest = collapse_doubles(rest)
    rest = re.sub(r'(?<=[a-z.,0-9])(?=[A-Z])', ' ', rest).strip()
    town = collapse_doubles(town)
    if len(town) >= 3 and rest:
        return f'{town.title()} ({rest})'
    return rest or town or name


def clean_stops(stops):
    out = []
    for s in stops:
        name = re.sub(r'\s+', ' ', s['name']).strip()
        toks0 = name.split()
        if len(toks0) >= 2 and len(toks0) % 2 == 0 and toks0[:len(toks0)//2] == toks0[len(toks0)//2:]:
            name = ' '.join(toks0[:len(toks0)//2])  # two-direction sheets print the name twice
        if not name or JUNK_ROW.match(name): continue
        toks = name.split()
        soupy = len(toks) >= 4 and sum(1 for t in toks if len(t) == 1) / len(toks) > 0.4
        if soupy and not s['times']:
            continue  # interleaved label soup with no data, not a stop
        if soupy:
            name = deinterleave(name)
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


OPERATOR_NAMES = {
    'AST': 'Azienda Siciliana Trasporti',
    'INTERBUSSPA': 'Interbus',
    'Etna': 'Etna Trasporti',
    'SAISTRASPORTI': 'SAIS Trasporti',
    'SAISAUTOLINEE': 'SAIS Autolinee',
    'AUTOTRASPORTICUFFARO': 'Autotrasporti Cuffaro',
    'AUTOLINEEREGIONALI': 'Autolinee Regionali',
    'ANSELMOCACCIATORE': 'Anselmo Cacciatore',
    'CAMILLERIARGENTOLATTUCA': 'Camilleri Argento & Lattuca',
    'CAMILLERIARGENTOSRL': 'Camilleri Argento',
    'CUFFAROANGELOERAFFAELE': 'Cuffaro Angelo e Raffaele',
    'CUFFAROVINCENZOECSRL': 'Cuffaro Vincenzo & C.',
    'SALVATORELUMIASRL': 'Salvatore Lumia',
    'GIUNTABUSTRASPORTISNC': 'Giuntabus Trasporti',
    'CALATINABUSSERVICE': 'Calatina Bus Service',
    'SOMMATINESEVIAGGI': 'Sommatinese Viaggi',
    'FEDERICONICOLO': 'Federico Nicolò',
    'ORTOLANOPUGLISI': 'Ortolano e Puglisi',
    'ATMMAIDA': 'ATM Maida',
    'PATTI': 'F.lli Patti',
    'IONICA': 'Ionica',
    'IONICASPA': 'Ionica',
    'MAGISTRO': 'Magistro',
    'PANEPINTO': 'Panepinto',
    'TAI': 'TAI',
    'TAISRL': 'TAI',
    'CAMARDADRAGO': 'Camarda & Drago',
    'SALVATORELUMIA': 'Salvatore Lumia',
    'CUFFAROVINCENZOEC': 'Cuffaro Vincenzo & C.',
}


def op_display(op_dir):
    key = op_dir.split('__')[0]  # crawl names dirs OPERATOR__FILENAME
    key = re.sub(r'^(AST_prov.*)$', 'AST', key)
    key = re.sub(r'^(ETNA.*)$', 'Etna', key)
    key = re.sub(r'^(ORARI_INTERBUS.*)$', 'INTERBUSSPA', key)
    key = re.sub(r'(?<=.)_?ORARI.*$', '', key, flags=re.I).strip('_')
    key = re.sub(r'(SPA|SRL|SAS|SNC)$', '', key, flags=re.I) if len(key) > 7 else key
    key = key.replace('PIR_', '')
    if key in OPERATOR_NAMES: return OPERATOR_NAMES[key]
    if key.upper() in OPERATOR_NAMES: return OPERATOR_NAMES[key.upper()]
    return re.sub(r'([a-z])([A-Z])', r'\1 \2', key).replace('_', ' ').title()


def detect_title(grid):
    """Route name + cod from page header lines, with stop-based fallback."""
    header = ' § '.join(grid.get('header_lines', []))
    cod = None
    m = re.search(r'[co]od\.?\s*(\d+[a-zA-Z]?)', header)
    if m: cod = m.group(1)
    m = re.search(r'Orario\s+Autolinee?\s+Extraurban[aoe]e?\s*:?\s*([A-Z][^§]{8,90}?)(?:\(|\s*$)', header, re.M)
    if m and m.group(1).count('-') >= 1:
        return re.sub(r'\s+', ' ', m.group(1)).strip(' -'), cod
    m = re.search(r'Impresa:\s*([^§]{4,120})', header)
    if m:
        rest = re.sub(r'\s+', ' ', m.group(1)).strip()
        rest = re.sub(r'^(Interbus|Etna\s+Trasporti|Azienda Siciliana Trasporti[^A-Z]*|A\.S\.T\.\s*S\.p\.A\.?)\s*', '', rest, flags=re.I)
        rest = re.sub(r'\s*Codice\s+\d+.*$', '', rest)
        rest = re.sub(r'\s*Denominazion.*$', '', rest, flags=re.I)
        # company-name leftovers mean the line wasn't a route — reject them
        if re.search(r'\b(s\.?a\.?s|s\.?r\.?l|s\.?p\.?a|& C\.|F\.lli|autolinee|autoservizi)\b', rest, re.I):
            return None, cod
        if rest.count('-') >= 1 and len(rest) > 8:
            return rest.strip(' -'), cod
    return None, cod


def route_name_fallback(route):
    for d in route['directions']:
        if d['stops']:
            first = d['stops'][0].split('(')[0].strip()
            last = d['stops'][-1].split('(')[0].strip()
            if first and last: return f'{first} - {last}'
    return 'Unknown route'


def main():
    os.makedirs(OUT, exist_ok=True)
    seed = json.load(open(os.path.join(ROOT, 'seed_routes.json'), encoding='utf-8'))
    seeded = {(e['dir'], e['page']) for e in seed}
    report, qa = [], {'ok': 0, 'no_trips': 0, 'no_grid_pages': 0}

    entries = []
    for e in seed:  # normalize seed agency names to match auto entries
        e = dict(e)
        e['agency'] = OPERATOR_NAMES.get(e['agency'], e['agency'])
        entries.append(e)
    for op in sorted(os.listdir(GRIDS)):
        for pf in sorted(os.listdir(os.path.join(GRIDS, op))):
            if (op, pf) in seeded: continue
            grid = json.load(open(os.path.join(GRIDS, op, pf), encoding='utf-8'))
            name, cod = detect_title(grid)
            rid = f"{re.sub(r'[^a-z0-9]+', '-', op.lower()).strip('-')[:28]}-{cod or 'p' + pf[1:4].lstrip('0')}"
            entries.append({'route_id': rid, 'agency': op_display(op), 'name': name or '',
                            'dir': op, 'page': pf, 'auto': True})

    seen_ids = set()
    for entry in entries:
        try:
            route = assemble_page(entry['dir'], entry['page'], entry)
        except FileNotFoundError:
            qa['no_grid_pages'] += 1; continue
        if not entry.get('name'):
            route['name'] = entry['name'] = route_name_fallback(route)
        rid = entry['route_id']
        while rid in seen_ids: rid += 'x'
        seen_ids.add(rid)
        route['route_id'] = rid
        n_trips = sum(len(d['trips']) for d in route['directions'])
        n_valid = sum(1 for d in route['directions'] for t in d['trips'] if t['valid'])
        if n_valid == 0:
            qa['no_trips'] += 1
            continue
        qa['ok'] += 1
        with open(os.path.join(OUT, f'{rid}.json'), 'w', encoding='utf-8') as f:
            json.dump(route, f, ensure_ascii=False, indent=1)
        report.append(f"{rid:34} trips={n_trips:3} valid={n_valid:3}  {entry['name'][:44]}")
    print('\n'.join(report))
    print(f"\nQA: routes_ok={qa['ok']} pages_no_valid_trips={qa['no_trips']} grid_missing={qa['no_grid_pages']}")


if __name__ == '__main__':
    main()
