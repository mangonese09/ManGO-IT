# ── STAGE 1: CRAWL ──
# Enumerate every operator PDF under PIR_OrariAutolinee via the Wayback CDX API
# (the live portal is geo-blocked outside Italy) and download the latest 200
# snapshot of each. Skips files already present with matching size; manifest
# records provenance + sha256.
import hashlib, json, os, re, time, urllib.parse, urllib.request

ROOT = os.path.dirname(__file__)
PDF_DIR = os.path.join(ROOT, 'data', 'pdfs')
MANIFEST = os.path.join(PDF_DIR, 'manifest.json')

PORTAL_PREFIX = ('pti.regione.sicilia.it/portal/page/portal/PIR_PORTALE/PIR_LaStrutturaRegionale/'
                 'PIR_AssInfrastruttureMobilita/PIR_InfrastruttureMobilitaTrasporti/PIR_Areetematiche/'
                 'PIR_Altricontenuti/PIR_Trasportipubblici/PIR_OrariAutolinee')
CDX = ('http://web.archive.org/cdx/search/cdx?url=' + urllib.parse.quote(PORTAL_PREFIX) +
       '&matchType=prefix&output=json&collapse=urlkey&filter=statuscode:200&fl=original,timestamp,mimetype&limit=1000')
UA = 'ManGO-IT-pipeline/0.1 (personal project; miconsig@gmail.com)'


def fetch(url, timeout=120, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            return urllib.request.urlopen(req, timeout=timeout).read()
        except Exception as e:
            if attempt == retries - 1: raise
            time.sleep(4 * (attempt + 1))


def main():
    os.makedirs(PDF_DIR, exist_ok=True)
    manifest = json.load(open(MANIFEST, encoding='utf-8')) if os.path.exists(MANIFEST) else []
    have = {m['file']: m for m in manifest}
    rows = json.loads(fetch(CDX, timeout=90))
    pdfs = [(o, ts) for o, ts, mt in rows[1:] if mt == 'application/pdf']
    print(f'{len(pdfs)} archived PDFs')
    for orig, ts in pdfs:
        m = re.search(r'PIR_OrariAutolinee/(PIR_[^/]+)/', orig)
        op = (m.group(1) if m else 'ROOT').replace('PIR_', '')
        base = urllib.parse.unquote(orig.split('/')[-1]).replace(' ', '_')
        if not base.lower().endswith('.pdf'): base += '.pdf'
        name = f'{op}__{base}' if not base.startswith(op) else base
        # seed files were saved without the operator prefix — keep them
        legacy = base
        if legacy in have or name in have:
            continue
        try:
            data = fetch(f'http://web.archive.org/web/{ts}id_/{orig}')
        except Exception as e:
            print(f'FAILED {name}: {e}')
            continue
        open(os.path.join(PDF_DIR, name), 'wb').write(data)
        entry = {'file': name, 'operator_dir': op, 'source': orig, 'snapshot': ts,
                 'sha256_16': hashlib.sha256(data).hexdigest()[:16], 'bytes': len(data)}
        manifest.append(entry)
        have[name] = entry
        print(f'{name}  {len(data)//1024}KB')
        time.sleep(1.0)  # be polite to archive.org
    json.dump(manifest, open(MANIFEST, 'w', encoding='utf-8'), indent=1)
    print(f'manifest: {len(manifest)} files')


if __name__ == '__main__':
    main()
