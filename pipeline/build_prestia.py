#!/usr/bin/env python3
# build_prestia.py — hand-encode the six Prestia e Comandè lines (from the
# operator's own timetable PDFs) into data/routes/prestia-*.json, in the same
# schema assemble.py emits for the portal operators, so geocode.py + emit_gtfs.py
# pick them up with zero special-casing.
#
# Time fidelity per line:
#   • Cianciana, S.Cristina-Piana, S.Stefano Q.-Sciacca — EXACT per-stop times
#     (the PDFs print a time for every stop; transcribed verbatim).
#   • Airport & Mondello shuttles — endpoints are exact departure clocks; the
#     intermediate curb stops are placed with a structural offset model (dense
#     city cluster, then one long highway leg to PUNTA RAISI) because the PDF
#     only gives approximate "minutes-to-airport" marketing figures. Offsets are
#     chosen to keep every leg under the 110 km/h speed gate.
#   • Terrasini-Palermo — collapsed to its 5 coastal towns + 3 Palermo anchors
#     (the ~20 fine AMAT curb stops within Palermo duplicate the airport line's
#     and carry the highest mis-transcription risk); representative offsets.
import json, os, re

ROOT = os.path.dirname(__file__)
OUT = os.path.join(ROOT, 'data', 'routes')
OP = 'Prestia e Comandè'

# ── service templates ────────────────────────────────────────────────────────
FERIALI = {'days': 'mon-sat', 'school': None, 'season': None, 'raw': 'GIORNI FERIALI'}
DAILY = {'days': 'daily', 'school': None, 'season': None, 'raw': 'TUTTI I GIORNI'}
LUNVEN_SCOL = {'days': 'mon-fri', 'school': 'school-days-only', 'season': None, 'raw': 'LUN-VEN PERIODO SCOLASTICO'}
DOMFEST_SCOL = {'days': 'sun-holidays', 'school': 'school-days-only', 'season': None, 'raw': 'DOM E FESTIVI PERIODO SCOLASTICO'}
FER_SCOL = {'days': 'mon-sat', 'school': 'school-days-only', 'season': None, 'raw': 'FERIALE PERIODO SCOLASTICO'}
FER_ESTIVO = {'days': 'mon-sat', 'school': None, 'season': {'from': '11/06', 'to': '15/09'}, 'raw': 'FERIALE PERIODO ESTIVO'}
MONDELLO_SEASON = {'days': 'daily', 'school': None, 'season': {'from': '15/06', 'to': '31/10'}, 'raw': 'DAL 15/06 AL 31/10 TUTTI I GIORNI'}


def hhmm(mins):
    return f'{mins // 60:02d}:{mins % 60:02d}'


def to_min(t):
    h, m = re.split(r'[.:]', t)
    return int(h) * 60 + int(m)


def trip_from_offsets(corsa, service, stops, dep_clock, offsets):
    """Build a trip: stop i departs dep_clock + offsets[i] minutes."""
    base = to_min(dep_clock)
    st = []
    for i, (name, off) in enumerate(zip(stops, offsets)):
        t = hhmm(base + off)
        st.append({'stop': name, 'idx': i, 'arr': t, 'dep': t})
    return {'corsa': corsa, 'service': service, 'reverse': False, 'valid': True, 'stops': st}


def trip_from_times(corsa, service, stops, times):
    """Build a trip from an explicit per-stop time list; None skips a stop."""
    st = []
    for i, (name, t) in enumerate(zip(stops, times)):
        if t is None:
            continue
        tt = hhmm(to_min(t))
        st.append({'stop': name, 'idx': i, 'arr': tt, 'dep': tt})
    return {'corsa': corsa, 'service': service, 'reverse': False, 'valid': True, 'stops': st}


def write_route(rid, name, source, directions, short=''):
    route = {'operator': OP, 'route_id': rid, 'name': name, 'source': source,
             'short_name': short, 'directions': directions}
    path = os.path.join(OUT, f'{rid}.json')
    json.dump(route, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    ntrips = sum(len(d['trips']) for d in directions)
    print(f'  {rid}: {len(directions)} dir, {ntrips} trips -> {os.path.basename(path)}')


# ── LINE 1: Aeroporto ⇄ Palermo (year-round, daily incl. holidays) ───────────
def airport():
    out_stops = ['PALERMO (Stazione Centrale)', 'PALERMO (Via Roma 289)',
                 'PALERMO (Piazza Ruggero Settimo)', 'PALERMO (Via Libertà 45)',
                 'PALERMO (Via Libertà 95)', 'PALERMO (Via Libertà 171)',
                 'PALERMO (Via Libertà 203)', 'PALERMO (Viale Croce Rossa 125)',
                 'PALERMO (Viale Strasburgo 7)', 'PALERMO (Via Belgio 25)',
                 'AEROPORTO (Falcone Borsellino)']
    out_off = [0, 3, 6, 8, 10, 13, 15, 17, 19, 21, 50]
    out_deps = [hhmm(m) for m in range(to_min('03:30'), to_min('21:30') + 1, 30)]

    in_stops = ['AEROPORTO (Falcone Borsellino)', 'PALERMO (Via Belgio 2)',
                'PALERMO (Via A. De Gasperi 82)', 'PALERMO (Viale Croce Rossa 56)',
                'PALERMO (Via Libertà 106)', 'PALERMO (Via Libertà 80)',
                'PALERMO (Via Libertà, Via Notarbartolo)', 'PALERMO (Via Libertà 42)',
                'PALERMO (Piazza Ruggero Settimo)', 'PALERMO (Via Roma 265)',
                'PALERMO (Stazione Centrale)']
    in_off = [0, 20, 24, 27, 30, 32, 34, 36, 40, 45, 50]
    in_deps = ['05:05', '05:35', '06:05', '06:35', '07:35', '08:10', '08:35', '09:05',
               '09:35', '10:05', '10:35', '11:05', '11:35', '12:05', '12:35', '13:05',
               '13:35', '14:05', '14:35', '15:05', '15:35', '16:05', '16:35', '17:05',
               '17:35', '18:05', '18:35', '19:05', '19:35', '20:05', '20:35', '21:05',
               '21:35', '22:05', '22:35', '23:05', '23:35', '00:05', '00:35', '01:05']

    d0 = {'stops': out_stops, 'trips': [trip_from_offsets(f'A{i+1}', DAILY, out_stops, dep, out_off)
                                        for i, dep in enumerate(out_deps)]}
    d1 = {'stops': in_stops, 'trips': [trip_from_offsets(f'R{i+1}', DAILY, in_stops, dep, in_off)
                                       for i, dep in enumerate(in_deps)]}
    write_route('prestia-airport', 'Palermo - Aeroporto Falcone Borsellino (Shuttle)',
                'prestia/LineaPalermoAeroporto-V4.pdf', [d0, d1])


# ── LINE 2: Mondello ⇄ Aeroporto (seasonal 15/06–31/10, daily) ───────────────
def mondello():
    out_stops = ['MONDELLO (Parcheggio Galatea)', 'PALERMO (Viale Margherita di Savoia 17)',
                 'PALERMO (Viale Venere)', 'PALERMO (Viale Venere, Castelforte)',
                 "PALERMO (Viale dell'Olimpo)", 'PALERMO (Piazza Bolivar)',
                 'AEROPORTO (Falcone Borsellino)']
    out_off = [0, 5, 9, 13, 17, 21, 40]
    out_deps = ['04:00', '05:45', '07:45', '09:45', '11:45', '13:45', '15:45', '17:45', '19:00']

    in_stops = ['AEROPORTO (Falcone Borsellino)', 'PALERMO (Piazza Bolivar)',
                'PALERMO (Viale Venere, Castelforte)', 'PALERMO (Viale Venere)',
                'PALERMO (Via Margherita di Savoia)', 'PALERMO (Via Principe di Scalea)',
                'MONDELLO (Parcheggio Galatea)']
    in_off = [0, 19, 23, 27, 31, 35, 40]
    in_deps = ['08:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:30']

    d0 = {'stops': out_stops, 'trips': [trip_from_offsets(f'A{i+1}', MONDELLO_SEASON, out_stops, dep, out_off)
                                        for i, dep in enumerate(out_deps)]}
    d1 = {'stops': in_stops, 'trips': [trip_from_offsets(f'R{i+1}', MONDELLO_SEASON, in_stops, dep, in_off)
                                       for i, dep in enumerate(in_deps)]}
    write_route('prestia-mondello', 'Mondello - Aeroporto Falcone Borsellino (Shuttle estivo)',
                'prestia/Linea-Mondello-2026-Prestia-V8.pdf', [d0, d1])


# ── LINE 3: Cianciana ⇄ Palermo (exact times) ────────────────────────────────
def cianciana():
    out_stops = ['CIANCIANA (Corso Vittorio Emanuele)', 'ALESSANDRIA DELLA ROCCA', 'BIVONA',
                 'SANTO STEFANO QUISQUINA', 'BIVIO FILAGA', 'BIVIO LERCARA FRIDDI',
                 'PALERMO (Via T. Fazello)']
    out = [
        (FERIALI, ['4:30', '4:45', '5:00', '5:15', '5:30', '5:45', '7:00']),
        (LUNVEN_SCOL, ['5:30', '5:45', '6:00', '6:15', '6:30', '6:45', '8:00']),
        (FERIALI, ['7:15', '7:30', '7:45', '8:00', '8:15', '8:30', '9:45']),
        (FERIALI, ['11:00', '11:15', '11:30', '11:45', '12:00', '12:15', '13:30']),
        (DAILY, ['15:00', '15:15', '15:30', '15:45', '16:00', '16:15', '17:30']),
        (DOMFEST_SCOL, ['17:00', '17:15', '17:30', '17:45', '18:00', '18:15', '19:30']),
    ]
    in_stops = ['PALERMO (Via T. Fazello)', 'BIVIO LERCARA FRIDDI', 'BIVIO FILAGA',
                'SANTO STEFANO QUISQUINA', 'BIVONA', 'ALESSANDRIA DELLA ROCCA',
                'CIANCIANA (Corso Vittorio Emanuele)']
    inn = [
        (FERIALI, ['8:00', '9:15', '9:30', '9:45', '10:00', '10:15', '10:30']),
        (LUNVEN_SCOL, ['14:00', '15:15', '15:30', '15:45', '16:00', '16:15', '16:30']),
        (FERIALI, ['15:00', '16:15', '16:30', '16:45', '17:00', '17:15', '17:30']),
        (FERIALI, ['17:00', '18:15', '18:30', '18:45', '19:00', '19:15', '19:30']),
        (DAILY, ['19:00', '20:15', '20:30', '20:45', '21:00', '21:15', '21:30']),
        (DOMFEST_SCOL, ['20:30', '21:45', '22:00', '22:15', '22:30', '22:45', '23:00']),
    ]
    d0 = {'stops': out_stops, 'trips': [trip_from_times(f'A{i+1}', s, out_stops, t) for i, (s, t) in enumerate(out)]}
    d1 = {'stops': in_stops, 'trips': [trip_from_times(f'R{i+1}', s, in_stops, t) for i, (s, t) in enumerate(inn)]}
    write_route('prestia-cianciana', 'Cianciana - Bivona - Lercara Friddi - Palermo',
                'prestia/Quadro-Orari-Cianciana-Palermo-pubblico-V4.pdf', [d0, d1])


# ── LINE 4: S. Cristina Gela ⇄ Piana d. Albanesi ⇄ Palermo (Mon–Sat, exact) ──
def scristina():
    out_stops = ['S. CRISTINA GELA', 'PIANA DEGLI ALBANESI', 'PALERMO (Via T. Fazello)']
    out = [
        (FERIALI, ['6:10', '6:30', '7:30']),
        (LUNVEN_SCOL, ['6:25', '6:40', '7:45']),
        (LUNVEN_SCOL, [None, '6:40', '7:45']),
        (FERIALI, ['7:45', '8:15', '9:15']),
        (FERIALI, ['11:30', '11:45', '12:45']),
        (FERIALI, ['14:00', '14:15', '15:15']),
        (FERIALI, ['15:45', '16:00', '17:00']),
    ]
    in_stops = ['PALERMO (Via T. Fazello)', 'PIANA DEGLI ALBANESI', 'S. CRISTINA GELA']
    inn = [
        (FERIALI, ['8:00', '8:50', '9:10']),
        (LUNVEN_SCOL, ['12:30', '13:20', '13:40']),
        (FERIALI, ['13:30', '14:20', '14:40']),
        (FERIALI, ['14:30', '15:20', '15:40']),
        (LUNVEN_SCOL, ['14:35', '15:25', '15:45']),
        (LUNVEN_SCOL, ['15:35', '16:20', '16:40']),
        (FERIALI, ['17:00', '17:50', '18:10']),
        (FERIALI, ['19:00', '19:45', '20:10']),
    ]
    d0 = {'stops': out_stops, 'trips': [trip_from_times(f'A{i+1}', s, out_stops, t) for i, (s, t) in enumerate(out)]}
    d1 = {'stops': in_stops, 'trips': [trip_from_times(f'R{i+1}', s, in_stops, t) for i, (s, t) in enumerate(inn)]}
    write_route('prestia-scristina', 'S. Cristina Gela - Piana degli Albanesi - Palermo',
                'prestia/Quadro-Orari-S.-Cristina-G.-Piana-Palermo-pubblico-V8.pdf', [d0, d1])


# ── LINE 5: S. Stefano Quisquina ⇄ Sciacca (Mon–Sat, 1 trip/dir, exact) ──────
def sciacca():
    out_stops = ['SANTO STEFANO QUISQUINA (Via Roma)', 'BIVONA', 'ALESSANDRIA DELLA ROCCA',
                 'CIANCIANA', 'RIBERA', 'SCIACCA (Via Lioni)']
    out = [(FERIALI, ['5:45', '6:00', '6:15', '6:30', '7:00', '7:20'])]
    in_stops = ['SCIACCA (Via Lioni)', 'RIBERA', 'CIANCIANA', 'ALESSANDRIA DELLA ROCCA',
                'BIVONA', 'SANTO STEFANO QUISQUINA (Via Roma)']
    inn = [(FERIALI, ['14:15', '14:45', '15:15', '15:30', '15:45', '16:00'])]
    d0 = {'stops': out_stops, 'trips': [trip_from_times(f'A{i+1}', s, out_stops, t) for i, (s, t) in enumerate(out)]}
    d1 = {'stops': in_stops, 'trips': [trip_from_times(f'R{i+1}', s, in_stops, t) for i, (s, t) in enumerate(inn)]}
    write_route('prestia-ssquisquina-sciacca', 'Santo Stefano Quisquina - Cianciana - Ribera - Sciacca',
                'prestia/Volantino-S.-StefanoQ-Sciacca-Orizzontale-versione3.pdf', [d0, d1])


# ── LINE 6: Terrasini ⇄ Palermo (major stops, representative offsets) ────────
def terrasini():
    out_stops = ['TERRASINI (Via E. Consiglio)', 'CINISI (Corso Umberto I)',
                 'VILLAGRAZIA DI CARINI (S.S. 113)', 'CARINI (Corso Vittorio Emanuele)',
                 'CAPACI (Corso Vittorio Emanuele)', 'PALERMO (Viale Strasburgo 185)',
                 'PALERMO (Piazza Ruggero Settimo)', 'PALERMO (Stazione Centrale)']
    out_off = [0, 10, 20, 25, 30, 45, 80, 90]
    out_deps = [('5:50', FERIALI), ('6:35', FER_SCOL), ('7:00', FER_ESTIVO), ('9:00', FERIALI),
                ('11:15', FERIALI), ('13:30', FERIALI), ('15:45', FERIALI), ('18:00', FERIALI),
                ('19:45', FERIALI)]
    in_stops = ['PALERMO (Stazione Centrale)', 'PALERMO (Piazza Ruggero Settimo)',
                'PALERMO (Viale Strasburgo 7)', 'CAPACI (Corso Vittorio Emanuele)',
                'CARINI (Corso Vittorio Emanuele)', 'VILLAGRAZIA DI CARINI (S.S. 113)',
                'CINISI (Corso Umberto I)', 'TERRASINI (Via E. Consiglio)']
    in_off = [0, 10, 20, 55, 60, 65, 80, 90]
    in_deps = [('7:20', FERIALI), ('9:00', FERIALI), ('12:00', FERIALI), ('13:15', FERIALI),
               ('14:15', FERIALI), ('16:00', FERIALI), ('18:00', FERIALI), ('19:30', FERIALI)]
    d0 = {'stops': out_stops, 'trips': [trip_from_offsets(f'A{i+1}', s, out_stops, dep, out_off)
                                        for i, (dep, s) in enumerate(out_deps)]}
    d1 = {'stops': in_stops, 'trips': [trip_from_offsets(f'R{i+1}', s, in_stops, dep, in_off)
                                       for i, (dep, s) in enumerate(in_deps)]}
    write_route('prestia-terrasini', 'Terrasini - Cinisi - Carini - Capaci - Palermo',
                'prestia/Tabella-orari-tariffe-TERRASINI-V10.pdf', [d0, d1])


def main():
    os.makedirs(OUT, exist_ok=True)
    print('writing Prestia routes:')
    airport(); mondello(); cianciana(); scristina(); sciacca(); terrasini()


if __name__ == '__main__':
    main()
