// Per-CHANNEL automatic sending. Each channel of each project can have its own
// schedule (set in the Projects section). When a channel is due, that project's
// notice goes to just that channel.
//
// Four schedule types (channel.sched.type):
//   'weekly'    — every week on channel.sched.dow (0=Sun..6=Sat)
//   'biweekly'  — the 1st and 3rd <dow> of the month
//   'monthly'   — once a month on channel.sched.day (1..31, clamped to last day)
//   'twicedates'— on channel.sched.day1 and channel.sched.day2 (each clamped)
// Plus channel.sched.time ("HH:MM", Philippine/settings tz) and
// channel.sched.enabled (bool). No anti-spam: if due and there is something to
// announce, it sends; if nothing is in the window, it skips.
//
// A channel records channel.sched_last_sent = "YYYY-MM-DD" so it fires at most
// once per day even though the cron pings every ~10 minutes.
//
// Triggers: the in-process loop below, and GET /api/cron?key=… (cron-job.org).
// Add &dry=1 to preview without sending.
const { load, save } = require('./db');
const { sendProjectNotifications, projectReport, partsInTz } = require('./notify');

const pad = n => String(n).padStart(2, '0');
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Which day-of-month is the Nth given weekday? e.g. 3rd Monday.
// Returns the date number (1..31), or null if that Nth weekday doesn't exist.
function nthWeekdayDate(y, m, weekday, n) {
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  let day = 1 + ((weekday - firstDow + 7) % 7); // first occurrence of that weekday
  day += (n - 1) * 7;
  return day <= lastDayOfMonth(y, m) ? day : null;
}

// Is this channel due right now? `p` = {y,m,d,dow,hm} in the target timezone.
function channelIsDue(sched, P) {
  if (!sched || !sched.enabled) return false;
  const time = /^\d{2}:\d{2}$/.test(sched.time || '') ? sched.time : '09:00';
  if (time > P.hm) return false; // not yet time today
  const last = lastDayOfMonth(P.y, P.m);

  switch (sched.type) {
    case 'weekly':
      return P.dow === Number(sched.dow);

    case 'biweekly': {
      const wd = Number(sched.dow);
      const first = nthWeekdayDate(P.y, P.m, wd, 1);
      const third = nthWeekdayDate(P.y, P.m, wd, 3);
      return P.d === first || P.d === third;
    }

    case 'monthly': {
      const target = Math.min(Number(sched.day) || 1, last); // clamp 31 -> last day
      return P.d === target;
    }

    case 'twicedates': {
      const d1 = Math.min(Number(sched.day1) || 1, last);
      const d2 = Math.min(Number(sched.day2) || 1, last);
      return P.d === d1 || P.d === d2;
    }

    default:
      return false;
  }
}

function describe(sched) {
  if (!sched || !sched.enabled) return 'off';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const t = sched.time || '09:00';
  switch (sched.type) {
    case 'weekly': return `weekly ${DAYS[sched.dow]} ${t}`;
    case 'biweekly': return `1st & 3rd ${DAYS[sched.dow]} ${t}`;
    case 'monthly': return `monthly day ${sched.day} ${t}`;
    case 'twicedates': return `day ${sched.day1} & ${sched.day2} ${t}`;
    default: return 'off';
  }
}

async function runDueSchedules(log = () => {}, dry = false) {
  const db = load();
  const tz = db.settings.timezone || 'Asia/Manila';
  const P = partsInTz(new Date(), tz);
  const today = `${P.y}-${pad(P.m)}-${pad(P.d)}`;
  const status = { checked_at: `${today} ${P.hm} (${tz})`, mode: dry ? 'DRY RUN — nothing sent' : 'live', channels: [] };

  for (const p of db.projects) {
    for (const ch of (p.channels || [])) {
      const sched = ch.sched;
      if (!sched || !sched.enabled) continue; // this channel isn't scheduled
      const line = { project: p.name, channel: ch.name, schedule: describe(sched) };

      if (!channelIsDue(sched, P)) { line.note = 'not due now'; status.channels.push(line); continue; }
      if (ch.sched_last_sent === today) { line.note = 'already sent today'; status.channels.push(line); continue; }

      const rep = projectReport(p.id);
      const hasNews = rep && (rep.ooo.length || rep.holidayGroups.length);
      if (!hasNews) { line.note = 'due, but nothing to announce — skipped'; status.channels.push(line); continue; }

      if (dry) { line.note = 'DUE — would send now'; status.channels.push(line); continue; }

      // Send this project's notice to THIS channel only.
      const r = await sendProjectNotifications(p.id, new Date(), ch.id, 'auto');
      const ok = (r.results || []).some(x => x.ok && !x.skipped);
      if (ok) { ch.sched_last_sent = today; save(); }
      line.note = ok ? 'sent' : 'send failed — will retry next ping';
      line.results = r.results;
      status.channels.push(line);
      log(`[auto-send] ${p.name} #${ch.name}: ${line.note}`);
    }
  }
  if (!status.channels.length) status.note = 'No channels have a schedule enabled';
  return status;
}

function startScheduler(log = console.log) {
  setInterval(() => runDueSchedules(log).catch(e => log('[auto-send] error:', e.message)), 60 * 1000);
}

module.exports = { startScheduler, runDueSchedules };
