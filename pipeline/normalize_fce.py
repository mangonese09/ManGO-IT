#!/usr/bin/env python3
# normalize_fce.py — the raw Circumetnea GTFS ships with calendar.txt stamped
# 20250201–20250228 (a template that never gets its year bumped; the zip itself
# was regenerated 2026-02-13 yet still carries Feb-2025 dates, and a couple of
# the extension validity rows even have end < start). Left as-is, every FCE trip
# is non-routable for any current date. The operator's own download page states
# validity through 28/02/2028, and the service is plain day-of-week (weekday /
# saturday / sunday via SERVICEID_1/3/6), so we faithfully correct the obvious
# template bug: keep the day-of-week masks and start_date, extend end_date to the
# published 20280228. Every other file is copied through byte-for-byte.
#
# feed_info.txt carries the SAME stale template stamp (feed_end_date 20250228)
# and must be corrected too: GTFS consumers give feed_info.txt precedence over
# calendar end dates when judging expiry (Transitous CI rejected the feed as
# "expired" off feed_info alone — found via PR #2327's import check).
import csv, io, sys, zipfile, os

SRC = os.path.join(os.path.dirname(__file__), 'data', 'sources', 'fce', 'fce.gtfs.zip')
OUT = os.path.join(os.path.dirname(__file__), 'dist', 'fce.gtfs.zip')
NEW_END = '20280228'  # operator's own stated validity (download page + title)

def rewrite_calendar(raw: bytes) -> bytes:
    rd = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    fields = rd.fieldnames
    rows = list(rd)
    changed = 0
    for r in rows:
        if r.get('end_date') != NEW_END:
            r['end_date'] = NEW_END
            changed += 1
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, lineterminator='\n')
    w.writeheader()
    w.writerows(rows)
    print(f'  calendar.txt: extended end_date on {changed}/{len(rows)} service rows -> {NEW_END}')
    return buf.getvalue().encode('utf-8')

def rewrite_feed_info(raw: bytes) -> bytes:
    rd = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    fields = rd.fieldnames
    rows = list(rd)
    changed = 0
    for r in rows:
        if r.get('feed_end_date') not in (None, '', NEW_END):
            r['feed_end_date'] = NEW_END
            changed += 1
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields, lineterminator='\n')
    w.writeheader()
    w.writerows(rows)
    print(f'  feed_info.txt: extended feed_end_date on {changed}/{len(rows)} rows -> {NEW_END}')
    return buf.getvalue().encode('utf-8')

def main():
    with zipfile.ZipFile(SRC) as zin:
        names = zin.namelist()
        assert 'calendar.txt' in names, 'no calendar.txt in FCE feed'
        # sanity: every trip service_id must be defined in calendar.txt
        cal_ids = {row['service_id'] for row in csv.DictReader(
            io.StringIO(zin.read('calendar.txt').decode('utf-8-sig')))}
        trip_ids = {row['service_id'] for row in csv.DictReader(
            io.StringIO(zin.read('trips.txt').decode('utf-8-sig')))}
        missing = trip_ids - cal_ids
        assert not missing, f'trips reference undefined service_ids: {missing}'
        print(f'  {len(trip_ids)} trip service_ids, all defined in calendar.txt: {sorted(trip_ids)}')

        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zout:
            for n in names:
                data = zin.read(n)
                if n == 'calendar.txt':
                    data = rewrite_calendar(data)
                elif n == 'feed_info.txt':
                    data = rewrite_feed_info(data)
                zout.writestr(n, data)
    print(f'  wrote {OUT} ({os.path.getsize(OUT):,} bytes)')

if __name__ == '__main__':
    main()
