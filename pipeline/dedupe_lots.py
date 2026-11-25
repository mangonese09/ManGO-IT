#!/usr/bin/env python3
# dedupe_lots.py — which older routes the 2026 lot sheets supersede.
#
# The lot sheets (lots_parse.py) re-publish many lines the feed already carries from the older
# portal PDFs (Aug 2024 – Nov 2025). Shipping both would double every departure. An older route
# is superseded when a lot route
#   1. covers >= 60% of its towns, both terminals included, and
#   2. is the same operator, or shares >= 30% of its (town, time) pairs (same timetable, the
#      operator renamed or credited to the lot holder).
# SAIS (own API) is never touched. Writes data/lots-superseded.json (emit_gtfs.py skips those
# route ids) and data/reports/lots-dedupe.md listing every pair considered.
# Run after lots_parse.py.
import json, os, re, unicodedata

ROOT = os.path.dirname(__file__)
ROUTES = os.path.join(ROOT, 'data', 'routes')
OUT = os.path.join(ROOT, 'data', 'lots-superseded.json')
REPORT = os.path.join(ROOT, 'data', 'reports', 'lots-dedupe.md')
KEEP_PREFIX = ('sais', 'saist', 'lot')
STOPWORDS = {'SRL', 'SPA', 'SNC', 'SAS', 'S', 'R', 'L', 'P', 'A', 'C', 'E', 'DI', 'AUTOLINEE', 'AUTOSERVIZI',
             'AUTOTRASPORTI', 'TRASPORTI', 'VIAGGI', 'SERVIZI', 'TURISTICI', 'FLLI', 'F', 'LLI', 'CONSORZIO', 'LOTTO'}


def norm(s):
    s = unicodedata.normalize('NFD', s or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', ' ', s.upper())).strip()


def town(stop):
    t = re.split(r'\s+\(|\s+-\s+', stop, maxsplit=1)[0]
    t = norm(t)
    t = re.sub(r'^(BV|BIVIO)\s+', '', t)
    return t.replace('S ', 'SAN ', 1) if t.startswith('S ') else t


GAZ = []  # town names from the lot sheets (clean "TOWN (detail)"), longest first


def place(stop):
    """The town a stop is in: the longest lot-sheet town found as whole words in its name.
    Older sheets write 'PARTINICO VIA CALANDRINO', '4 BORGETTO VIA ROMITELLO 4', …"""
    n = ' ' + norm(stop) + ' '
    for g in GAZ:
        if ' ' + g + ' ' in n:
            return g
    return None


def op_words(op):
    return {w for w in norm(op).split() if w not in STOPWORDS and len(w) > 2}


def towns_of(r):
    d0 = r['directions'][0]['stops'] if r['directions'] else []
    seq = {place(s) for d in r['directions'] for s in d['stops']} - {None}
    ends = (next((place(x) for x in d0 if place(x)), None), next((place(x) for x in reversed(d0) if place(x)), None))
    return seq, ends


def timed(r):
    out = set()
    for d in r['directions']:
        for t in d['trips']:
            for s in t['stops']:
                h, m = re.split(r'[.:]', s['dep'])
                out.add((place(s['stop']), int(h) * 60 + int(m)))
    return out


def main():
    routes = {}
    for f in sorted(os.listdir(ROUTES)):
        if f.endswith('.json'):
            r = json.load(open(os.path.join(ROUTES, f), encoding='utf-8'))
            routes[r['route_id']] = r
    lots = {k: r for k, r in routes.items() if k.startswith('lot')}
    GAZ[:] = sorted({town(s) for r in lots.values() for d in r['directions'] for s in d['stops'] if len(town(s)) >= 3},
                    key=len, reverse=True)
    old = {k: r for k, r in routes.items() if not k.startswith(KEEP_PREFIX) and r.get('directions')}
    lot_info = {k: (towns_of(r)[0], op_words(r['operator']), timed(r)) for k, r in lots.items()}
    superseded, lines = {}, []
    for ok, r in sorted(old.items()):
        t_old, (a, b) = towns_of(r)
        if len(t_old) < 2 or not a or not b:
            continue  # too few recognisable towns to judge
        s_old = timed(r)
        w_old = op_words(r['operator'])
        best = None
        for lk, (t_lot, w_lot, s_lot) in lot_info.items():
            cov = len(t_old & t_lot) / len(t_old)
            if cov < 0.6 or a not in t_lot or b not in t_lot:
                continue
            same_op = bool(w_old) and w_old == w_lot  # one shared surname is not the same company
            share = len(s_old & s_lot) / max(1, len(s_old))
            if same_op or share >= 0.3:
                score = (cov + share, cov, share)
                if best is None or score > best[0]:
                    best = (score, lk, cov, share, same_op)
        if best:
            _, lk, cov, share, same_op = best
            superseded[ok] = lk
            lines.append(f'| {ok} | {r["operator"]} | {r["name"][:40]} | {lk} | {lots[lk]["operator"]} | {cov:.0%} | {share:.0%} | {"yes" if same_op else "no"} |')
    # One name per agency: a lot operator that matches an older sheet's operator (an "Srl" or a
    # truncated "S.R" on one of them) takes the feed's existing name; spellings among the lot
    # sheets that differ only in case or punctuation collapse to one.
    old_ops = {}
    for r in old.values():
        old_ops.setdefault(r['operator'], op_words(r['operator']))
    renamed = 0
    canon_lot = {}
    for lk, r in lots.items():
        w = op_words(r['operator'])
        if not w or r['operator'].startswith('Consorzio'):
            continue
        hit = next((o for o, ow in old_ops.items() if ow == w), None)
        name = hit or canon_lot.setdefault(frozenset(w), r['operator'])
        if name != r['operator']:
            r['operator'] = name
            renamed += 1
            json.dump(r, open(os.path.join(ROUTES, f'{lk}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"dedupe: {renamed} lot routes take the feed's existing operator name")
    # A lot sheet that names no operator is credited to the lot's contract holder; when it matches
    # an older route's timetable (>= 30% identical stop times), the older sheet's operator runs it.
    credit = {}
    for ok, lk in superseded.items():
        if lots[lk]['operator'].startswith('Consorzio'):
            share = len(timed(old[ok]) & lot_info[lk][2]) / max(1, len(timed(old[ok])))
            if share >= 0.3 and share > credit.get(lk, (0, ''))[0]:
                credit[lk] = (share, old[ok]['operator'])
    for lk, (_, op) in credit.items():
        r = lots[lk]
        r['operator'] = op
        json.dump(r, open(os.path.join(ROUTES, f'{lk}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    json.dump(dict(sorted(superseded.items())), open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    with open(REPORT, 'w', encoding='utf-8') as fh:
        fh.write('# Older routes superseded by the 2026 lot sheets\n\n')
        fh.write(f'{len(superseded)} of {len(old)} older routes (SAIS untouched). emit_gtfs.py skips them.\n\n')
        fh.write('| old route | old operator | name | lot route | lot operator | town cover | (town,time) shared | same operator |\n|---|---|---|---|---|---|---|---|\n')
        fh.write('\n'.join(lines) + '\n')
    print(f'dedupe: {len(credit)} unnamed lot sheets credited to their running operator')
    print(f'dedupe: {len(superseded)} older routes superseded by lot routes (report {os.path.relpath(REPORT, ROOT)})')


if __name__ == '__main__':
    main()
