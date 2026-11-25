#!/usr/bin/env python3
# lots_parse.py — the Region's 2026 per-lot timetable PDFs → data/routes/lot<N>-<linea>.json
#
# Since 1 July 2025 extraurban service runs under the 9-year regional contract in four lots
# (COTRAS / COSMO consortia, the old companies as subcontractors). The Region publishes one
# standard sheet per line (Regione Siciliana, Mobilità e trasporti › Trasporto persone gomma):
#   Lot 1 Palermo–Trapani (2026-03, 3 tables), Lot 2 Catania–Ragusa–Siracusa (2026-04).
# These are fresher than the portal PDFs the rest of the feed comes from (Aug 2024 – Nov 2025).
#
# Sheet layout (both lots): header "AUTOLINEA <name> LOTTO <n> LINEA <id>", operator line,
# corsa-number row (outbound | return), KM(<corsa>) header, per-corsa service labels, then one
# row per stop: C outbound times, C outbound km, STOP NAME, C return km, C return times; the
# stop's town in brackets on the next line. Return trips run bottom-to-top.
#
# Writes route JSON in the schema assemble.py emits, plus d['kms'] for km interpolation.
# Run: python pipeline/lots_parse.py   (then dedupe_lots.py, geocode, emit, validate)
import json, os, re, sys, unicodedata
import pdfplumber

sys.path.insert(0, os.path.dirname(__file__))
from assemble import classify_service  # noqa: E402

ROOT = os.path.dirname(__file__)
SRC = os.path.join(ROOT, 'data', 'lots')
OUT = os.path.join(ROOT, 'data', 'routes')
REPORT = os.path.join(ROOT, 'data', 'reports', 'lots.md')
FILES = [  # (file, lot)
    ('t1-tabelle_-orari_da_linea_1_a_linea_297.pdf', 1),
    ('t2-tabelle_-orari_da_linea_299_a_linea_344.pdf', 1),
    ('t3-tabelle-_orari_da_linea_350_a_new_alia-cerda.pdf', 1),
    ('orario_b2d178879e.pdf', 2),
]
TIME = re.compile(r'^\d{1,2}[:.,][0-5]\d$')  # '7,25' too: km values have 1 or 3 decimals
KM = re.compile(r'^\d+(?:[.,]\d+)*$|^-$|^#+$')  # '#######' = spreadsheet overflow, read as no km


def fix(s):
    # the sheets are cp1252 text that pdfplumber hands back with U+FFFD for accented letters
    return (s or '').replace('�', "'")


def slug(s):
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def to_min(t):
    h, m = re.split(r'[.:,]', t)
    return int(h) * 60 + int(m)


def hhmm(t):
    m = to_min(t)
    return f'{m // 60:02d}:{m % 60:02d}'


def km_float(s):
    if s in (None, '-') or s.startswith('#'):
        return None
    # "35,000" = 35.0 km ; "1.234,500" = 1234.5
    return float(s.replace('.', '').replace(',', '.'))


# town spellings on the sheets that no geocoder reads (abbreviations, typos)
TOWN_FIX = {
    'C/MARE': 'CASTELLAMMARE DEL GOLFO', 'C/MARE DEL GOLFO': 'CASTELLAMMARE DEL GOLFO',
    'C/FIMI': 'CALATAFIMI', 'TERRRASINI': 'TERRASINI',
}


def stop_name(raw, town):
    """'PRIZZI - Via Libertà' + (Prizzi) -> 'PRIZZI (Via Libertà)' (geocode.split_stop form)."""
    raw = re.sub(r'\s+', ' ', raw).strip(' -')
    # the bracketed town sometimes shares the name's line: "(ROCCAPALUMBA) ROCCAPALUMBA VIA …"
    m = re.match(r'^\(([^()]+)\)\s*(.+)$', raw) or re.match(r'^(.+?)\s*\(([^()]+)\)$', raw)
    if m and not town and m.group(1 if raw.startswith('(') else 2).isupper():
        town = m.group(1) if raw.startswith('(') else m.group(2)
        raw = (m.group(2) if raw.startswith('(') else m.group(1)).strip()
    # "CAPOLINEA DI PARTENZA SANTA NINFA (…)", "FERMATA INTERMEDIA …": role words, not place
    raw = re.sub(r'^(?:CAPOLINEA(?:\s+DI\s+(?:PARTENZA|ARRIVO))?|FERMATA(?:\s+INTERMEDIA)?)\s*:?\s*', '', raw, flags=re.I)
    # no town line: "ACATE - P.zza Libertà" names its town before the dash
    if not town:
        m = re.match(r"^([A-ZÀ-Ý' .]{3,}?)\s+-\s+(.+)$", raw)
        if m:
            town, raw = m.group(1), raw
    t = re.sub(r'\s+', ' ', (town or '')).strip().upper()
    t = re.sub(r'\s*\((?:AG|CL|CT|EN|ME|PA|RG|SR|TP)\)$', '', t).strip()   # province tag
    t2 = TOWN_FIX.get(t, t)
    if t2 != t:  # an abbreviation or typo the geocoder cannot read
        raw = re.sub('^' + re.escape(t), t2, raw, flags=re.I)
        t = t2
    if not t:
        return raw
    up = raw.upper()
    if up == t:
        return t
    rest = raw[len(t):].strip(' -') if up.startswith(t) else raw
    rest = re.sub(r'\s*\(\s*', ' - ', rest).replace(')', '').strip(' -')   # no nested brackets
    return f'{t} ({rest})' if rest else t


def lot_service(label):
    svc = classify_service(label)
    sq = re.sub(r'[^A-Z]', '', unicodedata.normalize('NFD', label or '').upper())
    # the shared classifier has no "daily"; these sheets say GIORNALIERA / GIORN for every day
    if 'FESTIV' not in sq and ('GIORNALIER' in sq or re.search(r'GIORN(?!I)', sq)):
        svc['days'] = 'daily'
    # "dal 1/9 al 31/5": a date window (may wrap past New Year; emit_gtfs.season_window handles it)
    sq2 = re.sub(r'[^A-Z0-9/]', '', (label or '').upper())
    m = re.search(r'DAL(\d{1,2}/\d{1,2})AL(\d{1,2}/\d{1,2})', sq2)
    if m and not svc.get('season'):
        svc['season'] = {'from': m.group(1), 'to': m.group(2)}
    return svc


def is_time(t):
    return bool(TIME.match(t)) or t == '-'


def row_cs(toks):
    """(C, K) layouts toks fits: C times, K km, name, K km, C times. K is C (a km column per
    corsa) or 1 (one shared km column, the older template)."""
    out = []
    for C in range(1, (len(toks) - 1) // 2 + 1):
        for K in sorted({C, 1}):
            if 2 * C + 2 * K + 1 > len(toks):
                continue
            if all(is_time(t) for t in toks[:C]) and all(is_time(t) for t in toks[-C:])                     and all(KM.match(t) for t in toks[C:C + K]) and all(KM.match(t) for t in toks[-C - K:-C])                     and not KM.match(toks[C + K]) and not KM.match(toks[-C - K - 1]):
                out.append((C, K))
    return out


INDEX = {}  # (lot, linea) -> operator, from the Lot 1 line index
LOT_HOLDER = {1: 'Consorzio Trasporti Siciliani Nord (Lotto 1)', 2: 'Consorzio Stabile Siciliano Mobilità Est (Lotto 2)'}


def load_index():
    path = os.path.join(SRC, 'lotto1_-_indice_elenco_linee.pdf')
    if not os.path.exists(path):
        return
    with pdfplumber.open(path) as pdf:
        for line in fix(chr(10).join(p.extract_text() or '' for p in pdf.pages)).split(chr(10)):
            m = re.match(r'^(\S+)\s+.*?\s(?:COTRAS|COSMO)\s+(.*)$', line.strip())
            if m:
                INDEX[(1, m.group(1))] = re.sub(r'^.*in subappalto a\s+', '', m.group(2)).strip()


def parse_page(page):
    text = fix(page.extract_text() or '')
    lines = [l for l in text.splitlines() if l.strip()]
    hi = next((i for i, l in enumerate(lines) if l.startswith('AUTOLINEA')), None)
    if hi is None:
        return None, 'not a lot sheet (no AUTOLINEA header)'
    # long route names wrap: join the next line when LINEA is not on the first one
    head = lines[hi] if 'LINEA' in lines[hi][9:] else lines[hi] + ' ' + (lines[hi + 1] if hi + 1 < len(lines) else '')
    m = re.match(r'AUTOLINEA:?\s+(.*?)\s+LOT(?:TO)?\s*(\d+)\s+(?:ID\s+)?LINEA?\s*(?:N\.?\s+)?(\S+)', head, re.I)
    if not m:
        return None, f'header not parsed: {head[:80]}'
    name, lot, linea = m.group(1).strip(), int(m.group(2)), m.group(3)
    if 'LINEA' not in lines[hi][9:]:
        hi += 1  # the header wrapped onto two lines
    operator = re.sub(r'\s*Orario Autolinee Extraurbane\s*$', '', lines[hi + 1]).strip()
    # the line after the header is sometimes the corsa-number row, not an operator
    if not operator or 'CORSE' in operator.replace(' ', '') or sum(ch.isdigit() for ch in operator) > len(operator) / 3:
        # Lot 2's "Allegato C" sheets name no operator: credit the lot's contract holder
        # (Regione Siciliana, 25 Mar 2025) rather than guess the subcontractor
        operator = INDEX.get((lot, linea), '') or LOT_HOLDER.get(lot, '')
    if not operator:
        return None, f'line {linea}: operator not named on the sheet or in the index'
    if re.search(r'\bSAIS\b', operator, re.I):
        return None, f'SAIS ({operator}): comes from the SAIS API, skipped'

    words = [dict(w, text=fix(w['text'])) for w in page.extract_words(keep_blank_chars=False, use_text_flow=False)]
    if not any('STAZIONAMENTI' in w['text'] for w in words):
        return None, 'no STAZIONAMENTI'
    # rows of words, top within 2pt
    rows = []
    for w in sorted(words, key=lambda w: (w['top'], w['x0'])):
        if rows and abs(rows[-1][0] - w['top']) < 2:
            rows[-1][1].append(w)
        else:
            rows.append([w['top'], [w]])
    for r in rows:
        r[1].sort(key=lambda w: w['x0'])
    # A page holds one table (stop names in the middle, one direction each side) or two stacked
    # tables (names on the left, every trip to the right, one direction per table).
    stazs = []
    for w in sorted((w for w in words if 'STAZIONAMENTI' in w['text']), key=lambda w: w['top']):
        if not stazs or w['top'] - stazs[-1]['top'] > 20:
            stazs.append(w)
    directions = []

    def table(staz, bot, zone_lo, tagp):
        # Layout by position, not word count (some sheets leave cells blank, others print "-"):
        #  * a stop name is the run of closely spaced words around the STAZIONAMENTI column;
        #  * time columns are clusters of the x positions of times, left and right of the names;
        #  * km columns the same for distances.
        cx = lambda w: (w['x0'] + w['x1']) / 2
        scx = cx(staz)
        below = [(top, ws) for top, ws in rows if staz['top'] + 2 < top < bot]
        DATA = lambda t: bool(TIME.match(t)) or t in ('-', '|') or t.startswith('#')

        def name_run(ws):
            seeds = [w for w in ws if re.search('[A-Za-z]', w['text']) and not w['text'].upper().startswith('KM')]
            if not seeds:
                return None
            seed = min(seeds, key=lambda w: abs(cx(w) - scx))
            if abs(cx(seed) - scx) > 260:
                return None
            i = ws.index(seed); lo = hi = i

            # "ACATE - P.zza Libertà": a dash between two close words is part of the name, an
            # empty cell is a dash standing alone
            def inner(k, step):
                w = ws[k]
                if not DATA(w['text']):
                    return True
                n2 = k + step
                return w['text'] == '-' and 0 <= n2 < len(ws) and not DATA(ws[n2]['text']) \
                    and (ws[n2]['x0'] - w['x1'] if step > 0 else w['x0'] - ws[n2]['x1']) < 8
            while lo > 0 and ws[lo]['x0'] - ws[lo - 1]['x1'] < 8 and inner(lo - 1, -1):
                lo -= 1
            while hi + 1 < len(ws) and ws[hi + 1]['x0'] - ws[hi]['x1'] < 8 and inner(hi + 1, 1):
                hi += 1
            return ws[lo:hi + 1]

        def clusters(xs):
            xs = sorted(xs); out = []
            for x in xs:
                if out and x - out[-1][-1] <= 8:
                    out[-1].append(x)
                else:
                    out.append([x])
            return [sum(c) / len(c) for c in out]

        cand = []
        for top, ws in below:
            run = name_run(ws)
            if not run or re.fullmatch(r'\(.*\)', ' '.join(w['text'] for w in run)):
                continue
            lo, hi = run[0]['x0'], run[-1]['x1']
            times = [w for w in ws if TIME.match(w['text'])]
            if times:
                cand.append((top, ws, run, lo, hi))
        if len(cand) < 2:
            return f'{len(cand)} stop rows'
        first_top = cand[0][0]
        t_left = [cx(w) for _, ws, _, lo, _ in cand for w in ws if TIME.match(w['text']) and w['x1'] < lo]
        t_right = [cx(w) for _, ws, _, _, hi in cand for w in ws if TIME.match(w['text']) and w['x0'] > hi]
        k_left = [cx(w) for _, ws, _, lo, _ in cand for w in ws if KM.match(w['text']) and w['text'] != '-' and not TIME.match(w['text']) and w['x1'] < lo]
        k_right = [cx(w) for _, ws, _, _, hi in cand for w in ws if KM.match(w['text']) and w['text'] != '-' and not TIME.match(w['text']) and w['x0'] > hi]
        xs_out, xs_ret = clusters(t_left), clusters(t_right)
        xs_kmo, xs_kmr = clusters(k_left), clusters(k_right)
        allx = sorted(xs_out + xs_ret)
        pitch = min((b - a for a, b in zip(allx, allx[1:]) if b - a > 8), default=40)
        C = max(len(xs_out), len(xs_ret))

        def cell(ws, xs, pat):
            out = []
            for x in xs:
                hit = [w for w in ws if abs(cx(w) - x) < pitch * 0.5 and pat(w['text'])]
                out.append(hit[0]['text'] if hit else '-')
            return out

        stops = []
        for i, (top, ws, name_ws, _lo, _hi) in enumerate(cand):
            raw = ' '.join(w['text'] for w in name_ws)
            nxt = cand[i + 1][0] if i + 1 < len(cand) else 1e9
            town = ''
            for t2, ws2 in rows:
                if top < t2 < nxt and len(ws2) <= 6:
                    tx = ' '.join(w['text'] for w in ws2)
                    if re.fullmatch(r'\(.*\)', tx.strip()):
                        tm = re.match(r'\(([^()]*)\)', tx.strip())  # "(PALERMO) (PALERMO)": once
                        town = tm.group(1) if tm else tx.strip()[1:-1]
                        break
            stops.append((stop_name(raw, town), cell(ws, xs_out, TIME.match), cell(ws, xs_kmo, KM.match),
                          cell(ws, xs_kmr, KM.match), cell(ws, xs_ret, TIME.match)))

        # header zone (corsa ids, KM headers, service labels, often printed sideways): characters
        # between the CORSE banner and the first stop row, each column by x
        banner = zone_lo if zone_lo is not None else max((w['bottom'] for w in words if w['text'] in ('ANDATA', 'RITORNO') and w['top'] < first_top), default=staz['top'] - 60)
        chars = [c for c in page.chars if banner < c['top'] < first_top - 1]
        # Labels are small horizontal text wider than a column ("FERIALE" over "dal 1/9 al 31/5"),
        # so whole words go to the nearest time column, read row by row.
        tcols = xs_out + xs_ret
        title = banner if zone_lo is not None else max((w['bottom'] for w in words if w['text'].startswith('Extraurbane') and w['top'] < first_top), default=banner)
        zone = [w for w in words if max(banner, title) < w['top'] < first_top - 1 and not w['text'].upper().startswith('KM')
                and 'STAZIONAMENTI' not in w['text']]
        owner = {id(w): min(range(len(tcols)), key=lambda i: abs(tcols[i] - cx(w))) for w in zone}

        def col_text(x):
            i = tcols.index(x)
            ws = [w for w in zone if owner[id(w)] == i and not re.fullmatch(r'\d{3,}', w['text'])]
            ws.sort(key=lambda w: (round(w['top']), w['x0']))
            return ' '.join(w['text'] for w in ws)

        def corsa_id(x, k):
            i = tcols.index(x)
            ids = [w['text'] for w in zone if owner[id(w)] == i and re.fullmatch(r'[A-Za-z]*-?\d{3,}', w['text'])]
            return ids[-1] if ids else ''

        def trips_for(xs, pick, order, tag):
            trips = []
            for k, x in enumerate(xs):
                st = []
                for pos, si in enumerate(order):
                    t = pick(si)[k]
                    if TIME.match(t):
                        st.append({'stop': stops[si][0], 'idx': pos, 'arr': hhmm(t), 'dep': hhmm(t)})
                if len(st) < 2:
                    continue
                label = col_text(x)
                mins = [to_min(s['dep']) for s in st]
                trips.append({'corsa': f'{tag}{k + 1}' + (f'-{corsa_id(x, k)}' if corsa_id(x, k) else ''), 'service': lot_service(label or 'Feriale'), 'reverse': False,
                              'valid': all(b >= a for a, b in zip(mins, mins[1:])), 'stops': st})
            return trips

        n = len(stops)
        fwd, rev = list(range(n)), list(range(n - 1, -1, -1))
        # one km column per side, the fullest: each corsa's column counts from its own first
        # stop, so taking the first value on each row mixed bases (12.3 -> 3.2 -> 14.1)
        def km_col(idx):
            n_cols = max((len(s[idx]) for s in stops), default=0)
            if not n_cols:
                return [None] * len(stops)
            best = max(range(n_cols), key=lambda c: sum(1 for s in stops if c < len(s[idx]) and s[idx][c] != '-'))
            return [km_float(s[idx][best]) if best < len(s[idx]) else None for s in stops]
        kms_out, kms_ret = km_col(2), km_col(3)
        # Each side's stop order is whichever makes its times run forward: return columns normally
        # read bottom-to-top, but some Lot 2 sheets print a side in the other order.
        def side(xs, pick, order, tag, kms):
            best = None
            for o in (order, order[::-1]):
                t = trips_for(xs, pick, o, tag)
                ok = sum(1 for x in t if x['valid'])
                if best is None or ok > best[0]:
                    best = (ok, o, t)
            _, o, t = best
            if t:
                directions.append({'stops': [stops[i][0] for i in o], 'kms': [kms[i] for i in o], 'trips': t})
        side(xs_out, lambda si: stops[si][1], fwd, tagp + 'A', kms_out)
        side(xs_ret, lambda si: stops[si][4], rev, tagp + 'R', kms_ret)
        return cand[-1][0]
    zone_lo, errs = None, []
    for bi, st in enumerate(stazs):
        bot = stazs[bi + 1]['top'] - 1 if bi + 1 < len(stazs) else 1e9
        res = table(st, bot, zone_lo, f'T{bi + 1}' if len(stazs) > 1 else '')
        if isinstance(res, str):
            errs.append(res)
        else:
            zone_lo = res + 4
    if not directions:
        return None, '; '.join(errs) or 'no trips with two timed stops'
    route = {'operator': operator, 'route_id': f'lot{lot}-{slug(linea)}', 'name': name.upper(),
             'short_name': linea, 'source': None, 'lot': lot, 'directions': directions}
    return route, None


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.startswith('lot') and f.endswith('.json'):
            os.remove(os.path.join(OUT, f))
    load_index()
    routes, problems = {}, []
    for fname, lot in FILES:
        path = os.path.join(SRC, fname)
        with pdfplumber.open(path) as pdf:
            for pi, page in enumerate(pdf.pages, 1):
                r, err = parse_page(page.dedupe_chars())  # bold sheets overprint every letter
                if err:
                    problems.append(f'{fname} p{pi}: {err}')
                    continue
                r['source'] = f'{fname}#p{pi}'
                for d in r['directions']:  # trip ids stay unique when a line continues on the next page
                    for t in d['trips']:
                        t['corsa'] = f"p{pi}.{t['corsa']}"
                rid = r['route_id']
                if rid in routes:  # a line continued on the next page: same stops -> merge trips
                    prev = routes[rid]
                    if [d['stops'] for d in prev['directions']] == [d['stops'] for d in r['directions']]:
                        for a, b in zip(prev['directions'], r['directions']):
                            a['trips'].extend(b['trips'])
                        prev['source'] += f',p{pi}'
                        continue
                    k = 2
                    while f'{rid}-p{k}' in routes:
                        k += 1
                    r['route_id'] = rid = f'{rid}-p{k}'
                routes[rid] = r
    ntrips = nbad = 0
    for rid, r in routes.items():
        for d in r['directions']:
            ntrips += len(d['trips'])
            nbad += sum(1 for t in d['trips'] if not t['valid'])
        json.dump(r, open(os.path.join(OUT, f'{rid}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    with open(REPORT, 'w', encoding='utf-8') as fh:
        fh.write(f'# Lot sheets parse report\n\nroutes {len(routes)}, trips {ntrips}, non-monotonic (dropped at emit) {nbad}\n\n')
        fh.write('## Pages not parsed\n\n' + ('\n'.join(f'- {p}' for p in problems) or '(none)') + '\n')
    print(f'lots: {len(routes)} routes, {ntrips} trips ({nbad} non-monotonic), {len(problems)} pages not parsed')


if __name__ == '__main__':
    main()
