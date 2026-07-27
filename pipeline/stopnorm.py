# ── STOP NAME CANONICALIZATION (audit F-2) ──
# 573 likely-duplicate stop pairs existed because stop identity was the
# verbatim per-operator sheet spelling: 'RAFFADALI (Via Nazionale)',
# 'Raffadali (Via Nazionale', 'RAFFADALI ( Via Nazionale)' were three GTFS
# stops. Duplicate stops fragment departure boards and silently kill
# cross-operator transfers in MOTIS.
#
# canon_key() maps spelling variants of the SAME stop to one key:
# accent-fold, uppercase, expand Italian street abbreviations, drop
# stopwords, collapse punctuation. Merging still requires geographic
# proximity (emit checks <= MERGE_M metres) so same-named stops in
# different places never collapse.
import re
import unicodedata

MERGE_M = 120

_ABBREV = [
    (re.compile(r'\bP\.?\s?ZZA\b|\bP\.?\s?ZA\b|\bPZA\b|\bPZZA\b'), 'PIAZZA'),
    (re.compile(r'\bC\.?\s?SO\b'), 'CORSO'),
    (re.compile(r'\bV\.?\s?LE\b'), 'VIALE'),
    (re.compile(r'\bF\.?\s?S\.?\b|\bFF\.?\s?SS\.?\b'), 'STAZIONE'),
    (re.compile(r'\bSTAZ\.?\b'), 'STAZIONE'),
    (re.compile(r'\bS\.?\s?TA\b'), 'SANTA'),
    (re.compile(r'\bV\.?\s?EMANUELE\b'), 'VITTORIO EMANUELE'),
]
_STOPWORDS = {'DI', 'DEI', 'DEL', 'DELLA', 'DELLE', 'DEGLI', 'IL', 'LA', 'LO', 'N'}


def canon_key(name):
    s = unicodedata.normalize('NFD', name or '')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = s.upper()
    for rx, rep in _ABBREV:
        s = rx.sub(rep, s)
    s = re.sub(r'[^A-Z0-9]+', ' ', s)
    toks = [t for t in s.split() if t not in _STOPWORDS]
    return ' '.join(toks)


# Rule 2 (coordinate-first): two stops with RELIABLE coordinates within
# TIGHT_M metres sharing a significant name token are one physical stop even
# when described differently ('Terminal Bus Via Archimede' ~ "Via
# D'Amico/Archimede" at 0 m). Never applied to town/interpolated precision:
# centroid-fallback coords put DIFFERENT streets at 0 m from each other.
TIGHT_M = 25
PRECISE = {'exact', 'street', 'override'}
_GENERIC = {'VIA', 'VIALE', 'CORSO', 'PIAZZA', 'PIAZZALE', 'LARGO', 'TERMINAL', 'BUS',
            'STAZIONE', 'FERMATA', 'CAPOLINEA', 'FRONTE', 'INCROCIO', 'ANGOLO', 'KM', 'SNC'}


def sig_tokens(ck):
    """Significant tokens of a canon_key: everything after the town prefix
    that isn't street furniture and is ≥4 chars."""
    toks = ck.split()[1:]
    return {t for t in toks if t not in _GENERIC and len(t) >= 4}


def display_score(name, precision):
    """Which variant becomes the canonical display name: best coordinate
    precision wins, then the fullest spelling."""
    prec_rank = {'exact': 4, 'street': 3, 'override': 2, 'town': 1, 'interpolated': 0}
    return (prec_rank.get(precision, 0), sum(c.isalpha() for c in name or ''))


# ── PER-ROUTE STOP RENAMES (parse-damage corrections) ──
# pipeline/stop-renames.json: normalized junk spelling -> canonical name,
# scoped to a single route_id. See the file's _comment for the two damage
# classes. Applied by geocode.py AND emit_gtfs.py right after route load so
# both see identical names.
import json as _json
import os as _os

_RENAMES_F = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'stop-renames.json')
RENAMES = (_json.load(open(_RENAMES_F, encoding='utf-8')).get('per_route', {})
           if _os.path.exists(_RENAMES_F) else {})


def apply_renames(route):
    m = RENAMES.get(route.get('route_id'))
    if not m:
        return route
    def fix(name):
        return m.get(re.sub(r'\s+', ' ', name.upper().strip()), name)
    for d in route['directions']:
        d['stops'] = [fix(s) for s in d['stops']]
        for t in d['trips']:
            for s in t['stops']:
                s['stop'] = fix(s['stop'])
    return route
