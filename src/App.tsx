import React, { useEffect, useState, useCallback } from 'react';
import Timeline from 'react-calendar-timeline';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import 'react-calendar-timeline/lib/Timeline.css';
import './App.css';
import moment from 'moment';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Your Cloudflare Worker iCal proxy — replace if you redeploy
const PROXY = 'https://hospitable-availability.cardiffbungalows.workers.dev';

const PROPERTIES = [
  { id: 1,  title: 'Manchester Front', group: 'Cardiff',   ical: 'https://www.airbnb.com/calendar/ical/11699539.ics?t=951a8fe0d122429e83d4bc523f30d39d' },
  { id: 2,  title: 'Manchester Back',  group: 'Cardiff',   ical: 'https://www.airbnb.com/calendar/ical/4482203.ics?t=184ff40fd5df453785e6295ba70a1401' },
  { id: 3,  title: 'Montgomery North', group: 'Cardiff',   ical: 'https://www.airbnb.com/calendar/ical/40680181.ics?t=8b8ea2fc007d4e0b9142cd7c1f529e5d' },
  { id: 4,  title: 'Montgomery South', group: 'Cardiff',   ical: 'https://www.airbnb.com/calendar/ical/45713353.ics?t=3b9b2c86389f42e1b67317720549bb61' },
  { id: 5,  title: 'Fox Point Farms',  group: 'Encinitas', ical: 'https://www.airbnb.com/calendar/ical/1403880623009442540.ics?t=0b958bdfcb2b4583864fd8fab44b86e2' },
  { id: 6,  title: 'Capri Coastal',    group: 'Encinitas', ical: 'https://www.airbnb.com/calendar/ical/816935535589516337.ics?t=51219881c7d146448d50775130da1e54' },
  { id: 7,  title: 'Moonlight',        group: 'Leucadia',  ical: 'https://www.airbnb.com/calendar/ical/661174667073658869.ics?t=c44efbf6c3ba4a2aaa2fa98deb54cc7c' },
  { id: 8,  title: 'Beacons',          group: 'Leucadia',  ical: 'https://www.airbnb.com/calendar/ical/985569042249948402.ics?t=937dd836bd8940768e60d27104a60250' },
  { id: 9,  title: 'Grandview',        group: 'Leucadia',  ical: 'https://www.airbnb.com/calendar/ical/655912810650987847.ics?t=c2328d21a9024ab1b56a4de14a34847f' },
  { id: 10, title: 'Ponto',            group: 'Leucadia',  ical: 'https://www.airbnb.com/calendar/ical/936064461457570996.ics?t=bfc4414674e54c4382589a01a95a6f2f' },
];

const GROUPS = PROPERTIES.map(p => ({ id: p.id, title: p.title }));

// ─── iCAL PARSER ─────────────────────────────────────────────────────────────
function parseICalBusy(text: string): Array<{ start: moment.Moment; end: moment.Moment }> {
  const busy: Array<{ start: moment.Moment; end: moment.Moment }> = [];
  const events = text.split('BEGIN:VEVENT');
  events.shift();
  events.forEach(ev => {
    const startMatch = ev.match(/DTSTART[^:]*:([0-9T]+)/);
    const endMatch   = ev.match(/DTEND[^:]*:([0-9T]+)/);
    if (!startMatch || !endMatch) return;
    const parse = (s: string) => moment(s.replace(/[TZ]/g, '').slice(0, 8), 'YYYYMMDD');
    const start = parse(startMatch[1]);
    const end   = parse(endMatch[1]);
    if (start.isValid() && end.isValid()) busy.push({ start, end });
  });
  return busy;
}

// Convert busy blocks → available windows within an 18-month horizon
function busyToAvailableItems(
  propId: number,
  busy: Array<{ start: moment.Moment; end: moment.Moment }>,
  checkIn:  moment.Moment | null,
  checkOut: moment.Moment | null,
): any[] {
  const horizonStart = moment().startOf('day');
  const horizonEnd   = moment().add(18, 'months').endOf('day');

  const sorted = [...busy]
    .filter(b => b.end.isAfter(horizonStart) && b.start.isBefore(horizonEnd))
    .sort((a, b) => a.start.valueOf() - b.start.valueOf());

  const available: Array<{ start: moment.Moment; end: moment.Moment }> = [];
  let cursor = horizonStart.clone();

  sorted.forEach(b => {
    const bs = moment.max(b.start, horizonStart);
    const be = moment.min(b.end, horizonEnd);
    if (cursor.isBefore(bs)) available.push({ start: cursor.clone(), end: bs.clone() });
    if (be.isAfter(cursor))  cursor = be.clone();
  });
  if (cursor.isBefore(horizonEnd)) available.push({ start: cursor.clone(), end: horizonEnd.clone() });

  return available.map((av, i) => {
    const highlighted =
      checkIn && checkOut &&
      av.start.isSameOrBefore(checkIn, 'day') &&
      av.end.isSameOrAfter(checkOut, 'day');

    return {
      id:         `${propId}-${i}`,
      group:      propId,
      title:      'Available',
      start_time: av.start.valueOf(),
      end_time:   av.end.valueOf(),
      highlighted,
      canMove:    false,
      canResize:  false,
    };
  });
}

// ─── APP ──────────────────────────────────────────────────────────────────────
function App() {
  const [busyData,    setBusyData]    = useState<Map<number, Array<{ start: moment.Moment; end: moment.Moment }>>>(new Map());
  const [items,       setItems]       = useState<any[]>([]);
  const [loaded,      setLoaded]      = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [date,        setDate]        = useState<Date>(new Date());
  const [width,       setWidth]       = useState(window.innerWidth);
  const [checkIn,     setCheckIn]     = useState<Date | null>(null);
  const [checkOut,    setCheckOut]    = useState<Date | null>(null);
  const [searchMsg,   setSearchMsg]   = useState<{ text: string; type: 'success' | 'warning' | 'none' }>({ text: '', type: 'none' });

  const isMobile = width <= 768;

  // ── Fetch all iCal feeds ─────────────────────────────────────────────────
  useEffect(() => {
    const busyMap = new Map<number, Array<{ start: moment.Moment; end: moment.Moment }>>();
    let count = 0;

    PROPERTIES.forEach(prop => {
      const url = PROXY + '?url=' + encodeURIComponent(prop.ical);
      fetch(url)
        .then(r => r.text())
        .then(text => {
          busyMap.set(prop.id, parseICalBusy(text));
        })
        .catch(() => {
          busyMap.set(prop.id, []);
        })
        .finally(() => {
          count++;
          setLoaded(count);
          if (count === PROPERTIES.length) {
            setBusyData(new Map(busyMap));
            setLoading(false);
          }
        });
    });
  }, []);

  // ── Rebuild items when data or filter changes ─────────────────────────────
  useEffect(() => {
    if (busyData.size === 0) return;
    const inM  = checkIn  ? moment(checkIn).startOf('day')  : null;
    const outM = checkOut ? moment(checkOut).startOf('day') : null;
    const all: any[] = [];
    busyData.forEach((busy, propId) => {
      all.push(...busyToAvailableItems(propId, busy, inM, outM));
    });
    setItems(all);
  }, [busyData, checkIn, checkOut]);

  // ── Resize handler ───────────────────────────────────────────────────────
  useEffect(() => {
    const handle = () => setWidth(window.innerWidth);
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, []);

  // ── Date search ──────────────────────────────────────────────────────────
  const handleSearch = useCallback(() => {
    if (!checkIn || !checkOut) {
      setSearchMsg({ text: 'Please select both a check-in and check-out date.', type: 'warning' });
      return;
    }
    const inM  = moment(checkIn).startOf('day');
    const outM = moment(checkOut).startOf('day');
    if (!outM.isAfter(inM)) {
      setSearchMsg({ text: 'Check-out must be after check-in.', type: 'warning' });
      return;
    }
    // Jump timeline to check-in date
    setDate(checkIn);

    // Find properties where one available block fully covers the range
    const available = PROPERTIES.filter(prop => {
      const busy = busyData.get(prop.id) || [];
      const avItems = busyToAvailableItems(prop.id, busy, inM, outM);
      return avItems.some(it => it.highlighted);
    });

    const nights = outM.diff(inM, 'days');
    const dateStr = `${inM.format('MMM D')} – ${outM.format('MMM D, YYYY')}`;

    if (available.length === 0) {
      setSearchMsg({
        text: `No single property is fully open for ${nights} night${nights !== 1 ? 's' : ''} (${dateStr}). Try different dates or contact us — we may be able to help!`,
        type: 'warning',
      });
    } else {
      setSearchMsg({
        text: `${available.length} propert${available.length === 1 ? 'y' : 'ies'} available for ${nights} night${nights !== 1 ? 's' : ''} (${dateStr}): ${available.map(p => p.title).join(', ')}`,
        type: 'success',
      });
    }
  }, [checkIn, checkOut, busyData]);

  const handleClear = () => {
    setCheckIn(null);
    setCheckOut(null);
    setSearchMsg({ text: '', type: 'none' });
  };

  // ── Timeline config ──────────────────────────────────────────────────────
  const timeStart = moment(date).startOf('day').valueOf();
  const timeEnd   = moment(date).add(isMobile ? 3 : 2, 'months').valueOf();

  // ── Item renderer ────────────────────────────────────────────────────────
  const itemRenderer = ({ item, itemContext, getItemProps }: any) => {
    const bg     = item.highlighted ? '#3d6b2e' : '#6ba85a';
    const border = item.highlighted ? '#2a4a1e' : '#558847';
    return (
      <div
        title={`Available: ${moment(item.start_time).format('MMM D')} – ${moment(item.end_time).format('MMM D, YYYY')}`}
        {...getItemProps({
          style: {
            background:   bg,
            border:       `1px solid ${border}`,
            borderRadius: 3,
            color:        '#fff',
            fontSize:     11,
            fontFamily:   'Lato, sans-serif',
            fontWeight:   item.highlighted ? 700 : 400,
            letterSpacing: '0.04em',
          },
        })}
      >
        <div style={{
          height:       itemContext.dimensions.height,
          overflow:     'hidden',
          paddingLeft:  6,
          lineHeight:   `${itemContext.dimensions.height}px`,
          whiteSpace:   'nowrap',
          textOverflow: 'ellipsis',
        }}>
          {itemContext.title}
        </div>
      </div>
    );
  };

  // ── Group renderer ───────────────────────────────────────────────────────
  const groupRenderer = ({ group }: any) => {
    const prop = PROPERTIES.find(p => p.id === group.id);
    return (
      <div className="rct-group-item">
        <span className="group-title">{group.title}</span>
        {prop && <span className="group-subtitle">{prop.group}</span>}
      </div>
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="App">

      {/* Search bar */}
      <div className="search-section">
        <div className="search-row">
          <div className="search-field">
            <label className="search-label">Check-in</label>
            <DatePicker
              selected={checkIn}
              onChange={setCheckIn}
              selectsStart
              startDate={checkIn}
              endDate={checkOut}
              minDate={new Date()}
              placeholderText="Select date"
              popperClassName="custom-popper"
              className="date-input"
            />
          </div>
          <div className="search-field">
            <label className="search-label">Check-out</label>
            <DatePicker
              selected={checkOut}
              onChange={setCheckOut}
              selectsEnd
              startDate={checkIn}
              endDate={checkOut}
              minDate={checkIn || new Date()}
              placeholderText="Select date"
              popperClassName="custom-popper"
              className="date-input"
            />
          </div>
          <button className="search-btn" onClick={handleSearch} disabled={loading}>
            {loading ? `Loading (${loaded}/${PROPERTIES.length})` : 'Search Dates'}
          </button>
          {(checkIn || checkOut || searchMsg.type !== 'none') && (
            <button className="clear-btn" onClick={handleClear}>Clear</button>
          )}
        </div>

        {searchMsg.type !== 'none' && (
          <div className={`search-result ${searchMsg.type}`}>
            {searchMsg.text}
          </div>
        )}
      </div>

      {/* Jump to date */}
      <div className="jump-row">
        <span className="jump-label">Jump to date</span>
        <DatePicker
          selected={date}
          onChange={(d: Date | null) => { if (d) setDate(d); }}
          popperClassName="custom-popper"
          className="date-input date-input-small"
        />
        {loading && (
          <span className="loading-badge">
            <span className="loading-dot" />
            Loading {loaded}/{PROPERTIES.length} calendars...
          </span>
        )}
        {!loading && (
          <span className="live-badge">
            <span className="live-dot" />
            Live from Airbnb
          </span>
        )}
      </div>

      {/* Timeline */}
      <div className="timeline-wrap">
        <Timeline
          groups={GROUPS}
          items={items}
          visibleTimeStart={timeStart}
          visibleTimeEnd={timeEnd}
          itemRenderer={itemRenderer}
          groupRenderer={groupRenderer}
          sidebarWidth={isMobile ? 110 : 160}
          lineHeight={44}
          itemHeightRatio={0.65}
          canMove={false}
          canResize={false}
        />
      </div>

      <p className="calendar-note">
        Green blocks show available nights. Hover a block to see exact dates.
        {checkIn && checkOut && ' Darker green highlights properties matching your search dates.'}
      </p>
    </div>
  );
}

export default App;
