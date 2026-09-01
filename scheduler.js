// Per-PROJECT automatic sending. Each project has ONE schedule (set in the
// Projects section). When it is due, the project's notice goes to ALL of that
// project's Slack channels.
//
// Four schedule types (project.sched.type):
//   'weekly'     — every week on sched.dow (0=Sun … 6=Sat)
//   'biweekly'   — the 1st and 3rd <dow> of the month
//   'monthly'    — once a month on sched.day (1..31; 31 becomes the last day
//                  in shorter months)
//   'twicedates' — on sched.day1 and sched.day2 (each clamped the same way)
// Plus sched.time ("HH:MM" in the Settings timezone) and sched.enabled.
//
// Rules:
//  - If nothing is in the reporting window (nobody out, no holidays), skip.
//  - Sends at most once per project per day (project.sched_last_sent).
//  - If every channel fails, the day stays unmarked so the next ping retries.
//
// Triggers: the in-process loop below, and GET /api/cron?key=… from an external
// pinger (cron-job.org). Add &dry=1 to preview without sending.
const { load, save, saveNow } = require('./db');
const { sendProjectNotifications, projectReport, partsInTz } = require('./notify');

const pad = n => String(n).padStart(2, '0');
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Day-of-month for the Nth given weekday (e.g. 3rd Monday), or null if absent.
function nthWeekdayDate(y, m, weekday, n) {
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
  return day <= lastDayOfMonth(y, m) ? day : null;
}

// Is this schedule due right now? P = { y, m, d, dow, hm } in the target tz.
function isDue(sched, P) {
  if (!sched || !sched.enabled) return false;
  const time = /^\d{2}:\d{2}$/.test(sched.time || '') ? sched.time : '09:00';
  if (time > P.hm) return false; // the chosen time hasn't arrived yet today
  const last = lastDayOfMonth(P.y, P.m);
  const clamp = n => Math.min(Math.max(parseInt(n, 10) || 1, 1), last); // 31 -> last day

  switch (sched.type) {
    case 'weekly':
      return P.dow === Number(sched.dow);
    case 'biweekly': {
      const wd = Number(sched.dow);
      return P.d === nthWeekdayDate(P.y, P.m, wd, 1) || P.d === nthWeekdayDate(P.y, P.m, wd, 3);
    }
    case 'monthly':
      return P.d === clamp(sched.day);
    case 'twicedates':
      return P.d === clamp(sched.day1) || P.d === clamp(sched.day2);
    default:
      return false;
  }
}

function describe(sched) {
  if (!sched || !sched.enabled) return 'off';
  const t = sched.time || '09:00';
  switch (sched.type) {
    case 'weekly': return `every ${DAY_NAMES[sched.dow]} at ${t}`;
    case 'biweekly': return `1st & 3rd ${DAY_NAMES[sched.dow]} at ${t}`;
    case 'monthly': return `day ${sched.day} monthly at ${t}`;
    case 'twicedates': return `day ${sched.day1} & ${sched.day2} at ${t}`;
    default: return 'off';
  }
}

// Only one run at a time. The app's own timer and the external cron ping can
// arrive together; without this they would both start sending before either
// marked the day done. A run that arrives while another is in flight simply
// waits for it and reports its result.
let inFlight = null;
function runDueSchedules(log = () => {}, dry = false) {
  if (inFlight) return inFlight.then(() => ({ skipped: true, note: 'another run was already in progress' }));
  inFlight = doRun(log, dry).finally(() => { inFlight = null; });
  return inFlight;
}

async function doRun(log = () => {}, dry = false) {
  const db = load();
  const tz = db.settings.timezone || 'Asia/Manila';
  const P = partsInTz(new Date(), tz);
  const today = `${P.y}-${pad(P.m)}-${pad(P.d)}`;
  const status = { checked_at: `${today} ${P.hm} (${tz})`, mode: dry ? 'DRY RUN — nothing sent' : 'live', projects: [] };

  for (const p of db.projects) {
    if (p.archived) continue; // archived projects never send
    const sched = p.sched;
    if (!sched || !sched.enabled) continue; // no schedule on this project
    const line = { project: p.name, schedule: describe(sched) };

    if (!isDue(sched, P)) { line.note = 'not due now'; status.projects.push(line); continue; }
    if (p.sched_last_sent === today) { line.note = 'already sent today'; status.projects.push(line); continue; }

    const rep = projectReport(p.id);
    if (!rep || (!rep.ooo.length && !rep.holidayGroups.length)) {
      line.note = 'due, but nothing to announce — skipped';
      status.projects.push(line); continue;
    }
    if (!(p.channels || []).length) { line.note = 'due, but no channels configured'; status.projects.push(line); continue; }

    if (dry) {
      line.note = 'DUE — would send now';
      line.channels = p.channels.map(c => `#${c.name} (${c.purpose})`);
      status.projects.push(line); continue;
    }

    // Claim today BEFORE sending. Sending takes a few seconds, and if the flag
    // were set afterwards an overlapping run could slip past the check and send
    // a second copy. If nothing actually got delivered we roll the claim back so
    // the next ping retries.
    p.sched_last_sent = today; await saveNow();

    // Send to ALL of this project's channels.
    const r = await sendProjectNotifications(p.id, new Date(), null, 'auto');
    // Count only real deliveries — the informational "(email — send manually)"
    // line must not mask a failure, or email-marked projects would never retry.
    const delivered = (r.results || []).some(x => x.ok && !x.skipped);
    if (!delivered) { p.sched_last_sent = null; await saveNow(); }
    line.note = delivered ? 'sent' : 'all channels failed — will retry next ping';
    line.results = r.results;
    log(`[auto-send] ${p.name}: ${line.note}`);
    status.projects.push(line);
  }
  if (!status.projects.length) status.note = 'No projects have a schedule enabled';
  return status;
}

function startScheduler(log = console.log) {
  setInterval(() => runDueSchedules(log).catch(e => log('[auto-send] error:', e.message)), 60 * 1000);
}

module.exports = { startScheduler, runDueSchedules };
