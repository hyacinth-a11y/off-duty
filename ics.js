// Publishes "Who's Out" as an iCalendar (.ics) feed so Google Calendar, Outlook
// or Apple Calendar can subscribe to it and show everyone's time off alongside
// their own events.
//
// Served at GET /api/calendar.ics?key=…  (see server.js). The key is FEED_KEY if
// set, otherwise CRON_KEY, so the feed works without adding a new variable.
//
// What goes in the feed:
//   - APPROVED time-off only, as all-day events: "Alec Reyes — OOO"
//   - Holidays, listing the people whose employment status observes them
//   - A rolling window (90 days back, 18 months ahead) to keep the file small
//
// Note on Google: subscribed feeds are refreshed on Google's own schedule,
// often only every 8–24 hours. Apple and Outlook usually refresh sooner.
const { load } = require('./db');

const HOLIDAY_STATUS = { 'PH Employee': 'PH', 'US Employee': 'US' }; // contractors observe none

// --- iCalendar formatting helpers -------------------------------------------

// Escape the characters that carry meaning inside an iCalendar text value.
const esc = s => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

// Lines must be at most 75 octets; longer ones continue on a line starting with
// a single space. Folding on byte length (not characters) keeps UTF-8 safe.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0, limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // don't split in the middle of a multi-byte character
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((start ? ' ' : '') + bytes.slice(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines lose one octet to the leading space
  }
  return out.join('\r\n');
}

const ymdCompact = iso => iso.replace(/-/g, '');
const addDaysIso = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
};
const stampUtc = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// --- feed ---------------------------------------------------------------------

function buildIcs() {
  const db = load();
  const tz = (db.settings && db.settings.timezone) || 'Asia/Manila';
  const memberById = Object.fromEntries(db.members.map(m => [m.id, m]));
  const projectById = Object.fromEntries(db.projects.map(p => [p.id, p]));

  const today = new Date();
  const from = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + 550 * 86400000).toISOString().slice(0, 10);

  const dtstamp = stampUtc();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Off Duty//Team time off//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc("Off Duty — Who's Out")}`,
    `X-WR-CALDESC:${esc('Approved team time off and observed holidays')}`,
    `X-WR-TIMEZONE:${esc(tz)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  // Approved time off
  for (const t of db.timeoffs) {
    if (t.status !== 'approved') continue;
    if (t.end_date < from || t.start_date > to) continue;
    const member = memberById[t.member_id];
    if (!member) continue;
    const projects = (t.project_ids || []).map(id => (projectById[id] || {}).name).filter(Boolean);
    const desc = [
      projects.length ? `Projects: ${projects.join(', ')}` : 'No project assigned',
      t.note ? `Note: ${t.note}` : '',
      'From the Off Duty app',
    ].filter(Boolean).join('\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:timeoff-${t.id}@off-duty`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymdCompact(t.start_date)}`,
      // all-day events end the day AFTER the last day out
      `DTEND;VALUE=DATE:${ymdCompact(addDaysIso(t.end_date, 1))}`,
      fold(`SUMMARY:${esc(member.name)} — OOO`),
      fold(`DESCRIPTION:${esc(desc)}`),
      'TRANSP:TRANSPARENT',   // doesn't mark subscribers as busy
      'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }

  // Holidays, with the people who actually observe them
  for (const h of db.holidays) {
    if (h.date < from || h.date > to) continue;
    const observers = db.members.filter(m => HOLIDAY_STATUS[m.status] === h.location);
    if (!observers.length) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:holiday-${h.id}@off-duty`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymdCompact(h.date)}`,
      `DTEND;VALUE=DATE:${ymdCompact(addDaysIso(h.date, 1))}`,
      fold(`SUMMARY:${esc(h.name)} (${esc(h.location)} holiday)`),
      fold(`DESCRIPTION:${esc(`Observed by: ${observers.map(m => m.name).join(', ')}`)}\\nFrom the Off Duty app`),
      'TRANSP:TRANSPARENT',
      'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';   // iCalendar requires CRLF line endings
}

function feedKey() {
  return process.env.FEED_KEY || process.env.CRON_KEY || '';
}

module.exports = { buildIcs, feedKey };
