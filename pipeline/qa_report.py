# ── QA REPORT ──
# What shipped, what didn't, and why. Written to data/reports/qa.md.
import json, os, re

ROOT = os.path.dirname(__file__)
GRIDS = os.path.join(ROOT, 'data', 'grids')
ROUTES = os.path.join(ROOT, 'data', 'routes')
OUT = os.path.join(ROOT, 'data', 'reports', 'qa.md')


def main():
    shipped_sources = {}
    total_trips = 0
    low_conf_names = []
    for f in sorted(os.listdir(ROUTES)):
        r = json.load(open(os.path.join(ROUTES, f), encoding='utf-8'))
        shipped_sources[r['source']] = r
        for d in r['directions']:
            total_trips += sum(1 for t in d['trips'] if t['valid'])
            for s in d['stops']:
                if re.search(r'[A-Z][a-z]?[A-Z][a-z]?[A-Z]', s.replace(' ', '')) and '(' in s:
                    pass  # deinterleaved names are parenthesised; sample below
    ok_pages = len(shipped_sources)

    skipped = []
    for op in sorted(os.listdir(GRIDS)):
        for pf in sorted(os.listdir(os.path.join(GRIDS, op))):
            src = f'{op}/{pf}'
            if src in shipped_sources: continue
            g = json.load(open(os.path.join(GRIDS, op, pf), encoding='utf-8'))
            n_tables = len(g['tables'])
            reason = 'no table detected (cover/notes/continuation page?)' if n_tables == 0 \
                else 'tables found but no monotonic trips (layout family not handled?)'
            skipped.append((src, reason))

    ops = {}
    for r in shipped_sources.values():
        ops[r['operator']] = ops.get(r['operator'], 0) + 1

    lines = ['# Pipeline QA report', '',
             f'- pages shipped: {ok_pages}',
             f'- valid trips: {total_trips}',
             f'- operators covered: {len(ops)}',
             f'- pages skipped: {len(skipped)}', '',
             '## Routes per operator', '']
    for op, n in sorted(ops.items(), key=lambda x: -x[1]):
        lines.append(f'- {op}: {n}')
    lines += ['', '## Skipped pages (recovery backlog)', '']
    for src, reason in skipped:
        lines.append(f'- `{src}` — {reason}')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print(f'qa.md: {ok_pages} shipped, {len(skipped)} skipped, {total_trips} trips, {len(ops)} operators')


if __name__ == '__main__':
    main()
