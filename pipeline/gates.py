# ── SHARED TRIP GATES ──
# Review R-26: the GTFS build (emit_gtfs.py) and the app's served data
# (export_stops.py) were two independent exporters over the same routes/*.json,
# and only the GTFS side gated anything. The app shipped 906 trips the feed had
# already rejected — 777 of them speed-quarantined bad geocodes, so /api/direct
# would answer "Caltagirone 08:00 → Siracusa 08:10" (61 km in 10 minutes) for a
# corridor the validated feed knows better than to describe.
#
# Both exporters now call these. A gate added here reaches both by construction;
# that is the whole point of the module existing.
import math
import re

# Anonymous placeholder rows are unmappable and never ship. Cycle 4 widened
# this to the parse-damaged variants: OCR-ish suffixes ("Fermata intermedia I",
# "… 0") and collapsed counts ("10 Fermata intermedie 10"). Audit 2026-08-01
# widened again: an optional leading word ("ROCCAPALUMBA Fermata intermedia",
# "intermedia Fermata intermedia"), a trailing qualifier ("Fermata intermedia
# diretta"), and the Ionica column-header artifact ("I orario" / "0 orario")
# that shipped a phantom 2-stop trip with one stop in the open sea.
JUNK_STOP = re.compile(
    r"^(([\w'\.À-ù]+\s+)?\d{0,2}\s*Fermata( intermedi\w{0,2})?( [I0-9]{1,2})?( diretta)?"
    r"|Capolinea( di (Partenza|Arrivo))?"
    r"|[I0-9]{1,2}\s*orario"
    r"|[I0])\s*$", re.I)

# A coach cannot average this over a straight line between two consecutive
# stops; exceeding it means a bad geocode or a column misalignment.
MAX_KMH = 110
# Two stops timed at the same minute (or going backwards) can be a rounding
# artifact, but not if they are kilometres apart.
SAME_MINUTE_MAX_KM = 3
# R-16: the longest legitimate run measured in the corpus is 325 min
# (Militello–Scordia–Catania–Taormina–Messina). Everything above 360 is parse
# damage — `GIORNALIERA - Lido Bellia` ships stop times 0/720/3170 (52:50),
# which the speed gate structurally cannot see: an absurd duration reads as an
# absurdly LOW speed and lands in the warning tier beside legitimate school
# circuits. Span is the assertion that catches it.
MAX_SPAN_MIN = 360


# ── LOCAL (COMUNE) PATRON-SAINT HOLIDAYS ──
# Feste patronali are civil holidays in ONE comune only — Sant'Agata closes
# Catania but is a normal working day in Palermo, and Santa Rosalia the reverse.
# So they can't go in the region-wide holiday set (that would suppress real
# service everywhere else). Instead a date here applies to a trip only when the
# route serves the observing town, matched on the route name. Recurring by
# (month, day) so it needs no per-year maintenance. Curated to provincial
# capitals with a fixed-date civic patron; movable feasts (Trapani's Misteri on
# Good Friday, Ragusa Ibla's San Giorgio) are intentionally omitted.
LOCAL_HOLIDAYS = [
    {'town': 'PALERMO', 'm': 7, 'd': 15, 'name': 'Santa Rosalia'},
    {'town': 'CATANIA', 'm': 2, 'd': 5, 'name': "Sant'Agata"},
    {'town': 'SIRACUSA', 'm': 12, 'd': 13, 'name': 'Santa Lucia'},
    {'town': 'MESSINA', 'm': 6, 'd': 3, 'name': 'Madonna della Lettera'},
    {'town': 'AGRIGENTO', 'm': 2, 'd': 25, 'name': 'San Gerlando'},
    {'town': 'CALTANISSETTA', 'm': 9, 'd': 29, 'name': 'San Michele Arcangelo'},
    {'town': 'ENNA', 'm': 7, 'd': 2, 'name': 'Maria SS. della Visitazione'},
    {'town': 'RAGUSA', 'm': 8, 'd': 29, 'name': 'San Giovanni Battista'},
]


def route_local_hols(route_name):
    """(month, day) pairs a route observes as local holidays, by town name match."""
    up = (route_name or '').upper()
    return frozenset(
        (h['m'], h['d']) for h in LOCAL_HOLIDAYS
        if re.search(r'\b' + re.escape(h['town']) + r'\b', up))


def hav_km(a, b):
    """Great-circle km between (lat, lon) pairs."""
    p = math.pi / 180
    return 2 * 6371 * math.asin(math.sqrt(
        math.sin((b[0] - a[0]) * p / 2) ** 2 +
        math.cos(a[0] * p) * math.cos(b[0] * p) * math.sin((b[1] - a[1]) * p / 2) ** 2))


def is_junk_stop(name):
    return bool(JUNK_STOP.match((name or '').strip()))


def speed_violation(times, coords):
    """First implausible leg in a trip, or None.

    `times` are minutes from the service-day start (already unwrapped past
    midnight); `coords` are matching (lat, lon) pairs.
    """
    for i in range(len(times) - 1):
        ta, tb = times[i], times[i + 1]
        km = hav_km(coords[i], coords[i + 1])
        if tb <= ta:
            if km > SAME_MINUTE_MAX_KM:
                return (i, km, tb - ta)
        elif km / ((tb - ta) / 60) > MAX_KMH:
            return (i, km, tb - ta)
    return None


def span_violation(times):
    """Total trip duration in minutes if it exceeds MAX_SPAN_MIN, else None."""
    if len(times) < 2:
        return None
    span = times[-1] - times[0]
    return span if span > MAX_SPAN_MIN else None
