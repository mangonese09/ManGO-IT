# ── STAGE 2: EXTRACT ──
# PDF → per-page JSON: layout-preserved text lines, rotated-text column labels
# (service classes are printed vertically), and word boxes for downstream parsing.
# Output: pipeline/data/pages/{pdf-stem}/p{NNN}.json
import json, os, sys, warnings
warnings.filterwarnings('ignore')
import pdfplumber

ROOT = os.path.dirname(__file__)
PDF_DIR = os.path.join(ROOT, 'data', 'pdfs')
OUT_DIR = os.path.join(ROOT, 'data', 'pages')


def layout_lines(page):
    """Words grouped into lines by y, gap-padded by x so columns stay aligned."""
    words = page.extract_words(keep_blank_chars=False, use_text_flow=False)
    lines = {}
    for w in words:
        key = round(w['top'] / 3)  # 3pt line tolerance
        lines.setdefault(key, []).append(w)
    out = []
    for key in sorted(lines):
        ws = sorted(lines[key], key=lambda w: w['x0'])
        text, cursor = '', 0
        for w in ws:
            col = int(w['x0'] / 3.2)  # ~char-width columns
            if col > cursor: text += ' ' * (col - cursor)
            text += w['text'] + ' '
            cursor = col + len(w['text']) + 1
        out.append(text.rstrip())
    return out


def corsa_headers(words):
    """Reconstruct per-corsa service-class labels.

    The CORSE header band prints tiny per-column blocks (FERIALE / scolastico /
    festivo…) that cross-column line-grouping turns to soup. Find the corsa
    number row, then cluster header-band words to the nearest corsa x-centre.
    """
    corse_rows = {}
    for w in words:
        if w['t'] == 'C':
            row = [x for x in words if abs(x['y'] - w['y']) < 3 and x['t'] in list('CORSE')]
            if len(row) >= 5:
                corse_rows[round(w['y'])] = True
    if not corse_rows: return []
    corse_y = min(corse_rows)
    nums = [w for w in words
            if corse_y + 2 < w['y'] < corse_y + 22
            and w['t'].replace('A', '').replace('R', '').isdigit()]
    if not nums: return []
    num_y = min(w['y'] for w in nums)
    band = [w for w in words if num_y + 2 < w['y'] < num_y + 115 and len(w['t']) <= 16]
    out = []
    for n in sorted(nums, key=lambda w: w['x']):
        mine = [w for w in band if abs(w['x'] - n['x']) < 24]
        mine.sort(key=lambda w: (round(w['y'] / 6), w['x']))
        label = ''.join(w['t'] for w in mine)
        out.append({'corsa': n['t'], 'x': n['x'], 'label': label})
    return out


def extract_pdf(path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            words = [
                {'t': w['text'], 'x': round(w['x0'], 1), 'y': round(w['top'], 1)}
                for w in page.extract_words()
            ]
            data = {
                'pdf': os.path.basename(path), 'page': i,
                'lines': layout_lines(page),
                'corse': corsa_headers(words),
                'words': words,
            }
            with open(os.path.join(out_dir, f'p{i:03}.json'), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
            n += 1
    return n


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for f in sorted(os.listdir(PDF_DIR)):
        if not f.endswith('.pdf') or (only and only not in f): continue
        stem = f[:-4]
        n = extract_pdf(os.path.join(PDF_DIR, f), os.path.join(OUT_DIR, stem))
        print(f'{f}: {n} pages')


if __name__ == '__main__':
    main()
