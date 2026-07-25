# ── TUA AGRIGENTO (urban) ──
# Not on the regional portal; own PDF, own (simpler) layout: LOCALITA' rows,
# HH:MM columns, per-column Gior/Fer/Fest header, '=' means no service.
# Emits route JSONs in the same contract assemble.py produces, so geocode →
# emit → validate pick them up unchanged. Serves Valle dei Templi (L1) and
# San Leone (L2) — the tourist corridors.
import json, os, re, warnings
warnings.filterwarnings('ignore')
import pdfplumber

ROOT = os.path.dirname(__file__)
PDF = os.path.join(ROOT, 'data', 'pdfs', 'TUA__AGRIGENTO_URBANO.pdf')
OUT = os.path.join(ROOT, 'data', 'routes')

TIME = re.compile(r'^\d{1,2}:\d{2}$')
SVC = {'GIOR': 'daily', 'FER': 'mon-sat', 'FEST': 'sun-holidays', 'SCOL': 'school'}


def words_of(page):
    return [{'t': w['text'], 'x': round(w['x0'], 1), 'y': round(w['top'], 1)}
            for w in page.extract_words()]


def lines_of(words, tol=4):
    rows = {}
    for w in words:
        hit = next((y for y in rows if abs(y - w['y']) <= tol), None)
        if hit is None: rows[w['y']] = [w]
        else: rows[hit].append(w)
    return [sorted(v, key=lambda w: w['x']) for _, v in sorted(rows.items())]


def parse_table(lines, li_start, title):
    """One LOCALITA' block → trips. Returns (trips, stops, next_index)."""
    header = lines[li_start]
    svc_cols = [(w['x'], SVC.get(re.sub(r'[^A-Z]', '', w['t'].upper())[:4]))
                for w in header if re.sub(r'[^A-Z]', '', w['t'].upper())[:4] in SVC]
    stops, i = [], li_start + 1
    pending_name = []
    while i < len(lines):
        row = lines[i]
        txt = ' '.join(w['t'] for w in row)
        if re.match(r"^\s*(LOCALITA|Linea\s)", txt, re.I): break
        times = [w for w in row if TIME.match(w['t']) or w['t'] == '=']
        names = [w for w in row if not TIME.match(w['t']) and w['t'] != '=' and w['x'] < (times[0]['x'] if times else 900)]
        if times:
            name = ' '.join(w['t'] for w in pending_name + names).strip()
            pending_name = []
            if name:
                stops.append({'name': name, 'cells': times})
            elif stops:
                stops[-1]['cells'] += times
        elif names:
            pending_name += names
        i += 1
    if len(stops) < 2 or not svc_cols: return [], [], i
    # column x-centres from the union of all time cells
    xs = sorted({w['x'] for s in stops for w in s['cells']})
    cols, cur = [], []
    for x in xs:
        if cur and x - cur[-1] > 14: cols.append(sum(cur) / len(cur)); cur = []
        cur.append(x)
    if cur: cols.append(sum(cur) / len(cur))

    def col_of(x): return min(range(len(cols)), key=lambda c: abs(cols[c] - x))

    def svc_of(colx):
        if not svc_cols: return 'daily'
        return min(svc_cols, key=lambda s: abs(s[0] - colx))[1] or 'daily'

    trips = []
    for c in range(len(cols)):
        seq = []
        for idx, s in enumerate(stops):
            cell = next((w for w in s['cells'] if col_of(w['x']) == c and TIME.match(w['t'])), None)
            if cell:
                t = cell['t'].replace(':', '.')
                seq.append({'stop': f"AGRIGENTO ({s['name'].title().strip()})", 'idx': idx, 'arr': t, 'dep': t})
        if len(seq) < 2: continue
        days = svc_of(cols[c])
        service = {'days': 'mon-sat' if days == 'school' else days,
                   'school': 'school-days-only' if days == 'school' else None,
                   'season': None, 'raw': days}
        trips.append({'corsa': str(c + 1), 'service': service, 'reverse': False,
                      'stops': seq, 'valid': all(
                          int(a['arr'].split('.')[0]) * 60 + int(a['arr'].split('.')[1]) <=
                          int(b['arr'].split('.')[0]) * 60 + int(b['arr'].split('.')[1])
                          for a, b in zip(seq, seq[1:]))})
    stop_names = [f"AGRIGENTO ({s['name'].title().strip()})" for s in stops]
    return trips, stop_names, i


def main():
    os.makedirs(OUT, exist_ok=True)
    written = 0
    with pdfplumber.open(PDF) as pdf:
        line_name = 'Linea ?'
        for pi, page in enumerate(pdf.pages, 1):
            words = words_of(page)
            lines = lines_of(words)
            title = ''
            for row in lines[:4]:
                txt = ' '.join(w['t'] for w in row)
                m = re.match(r'^Linea\s+(\S+)', txt)
                if m: line_name = f'Linea {m.group(1)}'
                if txt.isupper() and ' - ' in txt: title = txt.strip()
            directions = []
            for li, row in enumerate(lines):
                if any(w['t'].upper().startswith("LOCALITA") for w in row):
                    trips, stop_names, _ = parse_table(lines, li, title)
                    if trips:
                        directions.append({'stops': stop_names, 'trips': trips})
            if not directions: continue
            rid = f"tua-{re.sub(r'[^a-z0-9]+', '-', line_name.lower())}-p{pi}"
            route = {'operator': 'TUA Agrigento', 'route_id': rid,
                     'name': f'{line_name}: {title}' if title else line_name,
                     'source': f'TUA__AGRIGENTO_URBANO/p{pi:03}.json',
                     'prescriptions': [], 'directions': directions}
            json.dump(route, open(os.path.join(OUT, f'{rid}.json'), 'w', encoding='utf-8'),
                      ensure_ascii=False, indent=1)
            n = sum(len(d['trips']) for d in directions)
            print(f'{rid}: {n} trips  {route["name"][:60]}')
            written += 1
    print(f'{written} TUA route pages')


if __name__ == '__main__':
    main()
