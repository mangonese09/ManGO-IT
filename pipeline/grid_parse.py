# ── STAGE 3a: GRID PARSE (deterministic) ──
# Page word-boxes → structured timetable grids. Handles the two layout families
# seen across AST / Interbus / Etna sheets:
#   A) single table, andata columns left of STAZIONAMENTI, ritorno columns right
#      (ritorno reads bottom-up)
#   B) one table per direction (CORSE header repeats), all columns read top-down
# Output: pipeline/data/grids/{stem}/pNNN.json
import json, os, re, sys

ROOT = os.path.dirname(__file__)
PAGES = os.path.join(ROOT, 'data', 'pages')
OUT = os.path.join(ROOT, 'data', 'grids')

TIME_RE = re.compile(r'^\d{1,2}[.:]\d{2}$')
COMMA_TIME_RE = re.compile(r'^\d{1,2},\d{2}$')  # some sheets print 10,50 for 10.50
CORSA_RE = re.compile(r'^\d{1,2}[AR]?$')
KM_RE = re.compile(r'^\d{1,3},\d{1,3}$')


def lines_of(words, tol=3.5):
    rows = {}
    for w in words:
        placed = False
        for y in list(rows):
            if abs(w['y'] - y) <= tol:
                rows[y].append(w); placed = True; break
        if not placed:
            rows[w['y']] = [w]
    return [sorted(v, key=lambda w: w['x']) for y, v in sorted(rows.items())]


def find_corse_headers(lines):
    """y positions of 'C O R S E' rows (letters spaced as single-char words)."""
    ys = []
    for row in lines:
        txt = ''.join(w['t'] for w in row)
        if 'CORSE' in txt.replace(' ', '') and len(row) <= 14:
            ys.append(row[0]['y'])
    return ys


def parse_page(data):
    words = data['words']
    lines = lines_of(words)
    header_ys = find_corse_headers(lines)
    if not header_ys:
        # No literal "C O R S E" header — fall back to corsa-number rows
        # (≥4 corsa tokens making up nearly the whole line).
        for row in lines:
            toks = [w for w in row if CORSA_RE.match(w['t'])]
            letters = [w for w in row if w['t'] in list('CORSE')]
            if len(toks) >= 4 and len(toks) + len(letters) >= len(row) - 1 and row[0]['y'] > 100:
                header_ys.append(row[0]['y'] - 4)
    if not header_ys:
        return None
    page_bottom = max(w['y'] for w in words) + 20
    tables = []
    # Family A: one CORSE header but corsa numbers appear left AND right → still one table
    bounds = header_ys + [page_bottom]
    merged = [(bounds[i], bounds[i + 1]) for i in range(len(header_ys))]
    # A single logical table may print CORSE twice on the same row (left+right block)
    dedup = []
    for y0, y1 in merged:
        if dedup and abs(dedup[-1][0] - y0) < 8:
            continue
        dedup.append((y0, y1))
    for y0, y1 in dedup:
        t = parse_table(words, lines, y0, y1)
        if t and t['stops']:
            tables.append(t)
    return {'pdf': data['pdf'], 'page': data['page'], 'tables': tables,
            'header_lines': [' '.join(w['t'] for w in r) for r in lines if r[0]['y'] < (header_ys[0] if header_ys else 1e9)][:8]}


def parse_table(words, lines, y0, y1):
    seg = [w for w in words if y0 < w['y'] < y1]
    if not seg: return None
    seg_lines = lines_of(seg)

    # corsa number row: first line below header made mostly of corsa tokens
    corse = []
    for row in seg_lines:
        toks = [w for w in row if CORSA_RE.match(w['t'])]
        letters = [w for w in row if w['t'] in list('CORSE')]
        if len(toks) >= 2 and len(toks) + len(letters) >= len(row) - 2:
            corse = [{'n': w['t'], 'x': w['x']} for w in toks]
            corsa_y = row[0]['y']
            break
    if not corse: return None

    xs = sorted(c['x'] for c in corse)
    spacing = min((b - a) for a, b in zip(xs, xs[1:])) if len(xs) > 1 else 40
    win = max(10, spacing * 0.48)

    # service labels: words between corsa row and first stop-time row
    stop_rows_start = None
    for row in seg_lines:
        if row[0]['y'] <= corsa_y + 2: continue
        if sum(1 for w in row if TIME_RE.match(w['t'])) >= 2:
            stop_rows_start = row[0]['y']; break
    label_band = [w for w in seg if corsa_y + 2 < w['y'] < (stop_rows_start or corsa_y + 120)]
    for c in corse:
        mine = [w for w in label_band if abs(w['x'] - c['x']) < win and not TIME_RE.match(w['t'])]
        mine.sort(key=lambda w: (round(w['y'] / 6), w['x']))
        c['label'] = ''.join(w['t'] for w in mine)[:120]

    # STAZIONAMENTI x-band: between the two halves of corsa columns, or where the
    # literal word appears
    staz_words = [w for w in seg if 'STAZIONAMENT' in w['t'].upper()]
    if staz_words:
        staz_x0 = staz_words[0]['x'] - 50
        staz_x1 = staz_words[0]['x'] + 165
    else:
        staz_x0, staz_x1 = 150, 420  # fallback: middle band

    # stop rows: lines with a name in the staz band and/or times at corsa columns
    stops = []
    pending_times = None
    for row in seg_lines:
        if row[0]['y'] <= corsa_y + 1: continue
        names = [w for w in row if staz_x0 <= w['x'] <= staz_x1 and not TIME_RE.match(w['t'])
                 and w['t'] not in ('-', '|') and not KM_RE.match(w['t'])]
        cells, kms = [], []
        for w in row:
            if TIME_RE.match(w['t']) or w['t'] in ('-', '|'):
                cells.append(w)
            elif COMMA_TIME_RE.match(w['t']) and min(abs(c['x'] - w['x']) for c in corse) < win:
                # comma-decimal time sitting in a corsa column, not a km value
                cells.append({'t': w['t'].replace(',', '.'), 'x': w['x'], 'y': w['y']})
            elif KM_RE.match(w['t']):
                kms.append(w['t'])
        name = ' '.join(w['t'] for w in names).strip()
        if re.match(r'^(C O R S E|Prescrizioni|Divieto|N\.B\.)', name):
            name = ''
        times = {}
        for w in cells:
            best = min(corse, key=lambda c: abs(c['x'] - w['x']))
            if abs(best['x'] - w['x']) < win + 6:
                times.setdefault(best['n'], w['t'])
        if name and times:
            stops.append({'name': name, 'km': kms, 'times': times})
            pending_times = None
        elif name and pending_times:
            stops.append({'name': name, 'km': pending_times['km'], 'times': pending_times['times']})
            pending_times = None
        elif name:
            stops.append({'name': name, 'km': kms, 'times': {}})
        elif times:
            # times-only line: belongs to the name line just before or just after
            if stops and not stops[-1]['times']:
                stops[-1]['times'] = times
                stops[-1]['km'] = stops[-1]['km'] or kms
            else:
                pending_times = {'times': times, 'km': kms}
    # merge marker rows ("Capolinea" / "Fermata intermedia" carry the times,
    # the real stop name sits on the adjacent name-only line)
    MARKERS = re.compile(r'^((Capolinea|Fermata|di|Partenza|Arrivo|intermedia|facoltativa|obbligatoria)\s*)+$', re.I)
    merged_stops, i = [], 0
    while i < len(stops):
        s = stops[i]
        if MARKERS.match(s['name']) and i + 1 < len(stops) and not stops[i + 1]['times'] \
                and not MARKERS.match(stops[i + 1]['name']):
            nxt = stops[i + 1]
            merged_stops.append({'name': nxt['name'], 'km': s['km'] or nxt['km'],
                                 'times': s['times'], 'kind': s['name']})
            i += 2
        elif MARKERS.match(s['name']) and s['times'] and merged_stops \
                and not merged_stops[-1]['times'] and not MARKERS.match(merged_stops[-1]['name']):
            # terminal rows print the name line ABOVE the marker line
            merged_stops[-1] = {'name': merged_stops[-1]['name'],
                                'km': s['km'] or merged_stops[-1]['km'],
                                'times': s['times'], 'kind': s['name']}
            i += 1
        else:
            if not re.search(r'viceversa|Prescrizioni|N\.B\.', s['name']):
                merged_stops.append(s)
            i += 1
    stops = [s for s in merged_stops if s['name'] and s['name'].upper() != 'STAZIONAMENTI']

    # prescriptions
    presc = []
    for row in seg_lines:
        txt = ' '.join(w['t'] for w in row)
        if re.search(r'Prescrizioni|Divieto|divieto', txt):
            presc.append(txt.strip()[:300])
    return {'corse': corse, 'stops': stops, 'prescriptions': presc,
            'spacing': round(spacing, 1)}


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for op in sorted(os.listdir(PAGES)):
        if only and only not in op: continue
        os.makedirs(os.path.join(OUT, op), exist_ok=True)
        for pf in sorted(os.listdir(os.path.join(PAGES, op))):
            data = json.load(open(os.path.join(PAGES, op, pf), encoding='utf-8'))
            grid = parse_page(data)
            if grid:
                with open(os.path.join(OUT, op, pf), 'w', encoding='utf-8') as f:
                    json.dump(grid, f, ensure_ascii=False, indent=1)
    print('grids written to', OUT)


if __name__ == '__main__':
    main()
