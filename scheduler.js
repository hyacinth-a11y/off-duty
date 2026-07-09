// Per-project automatic sending. Each project can have its own schedule
// (days of week + time, in the timezone from Settings — Asia/Manila by default),
// set in the Projects section. When due, the project's notice goes to ALL its
// Slack channels, exactly like pressing Send on each — but labeled "auto".
//
// Rules:
//  - Skips silently when the project has nothing to announce (no approved
//    time-off, no holiday members) — no "nobody is out" spam.
//  - Sends at most once per project per day.
//  - If EVERY channel fails (e.g. the app was mid-wake), it stays unmarked so
//    the next ping retries. If at least one channel succeeded, the day is
//    marked done to avoid duplicate messages.
//
// Triggers: the in-process loop below (while awake) and GET /api/cron?key=…
// from an external pinger like cron-job.org (wakes the app on free hosting).
// Add &dry=1 to preview decisions without sending anything.
const { load, save } = require('./db');
const { sendProjectNotifications, projectReport, partsInTz } = require('./notify');

const pad = n => String(n).padStart(2, '0');

async function runDueSchedules(log = () => {}, dry = false) {
  const db = load();
  const tz = db.settings.timezone || 'Asia/Manila';
  const { y, m, d, dow, hm } = partsInTz(new Date(), tz);
  const today = `${y}-${pad(m)}-${pad(d)}`;
  const status = { checked_at: `${today} ${hm} (${tz})`, mode: dry ? 'DRY RUN — nothing was sent' : 'live', projects: [] };

  for (const p of db.projects) {
    const line = { project: p.name };
    if (!p.auto_enabled) continue; // not scheduled — stay quiet about it
    if (!(p.auto_days || []).includes(dow)) { line.note = 'not a scheduled day'; status.projects.push(line); continue; }
    if ((p.auto_time || '09:00') > hm) { line.note = `due at ${p.auto_time} — not yet`; status.projects.push(line); continue; }
    if (p.auto_last_sent === today) { line.note = 'already handled today'; status.projects.push(line); continue; }

    const rep = projectReport(p.id);
    const hasNews = rep && (rep.ooo.length || rep.holidayGroups.length);
    if (!hasNews) {
      line.note = 'due, but nothing to announce — skipped';
      if (!dry) { p.auto_last_sent = today; save(); }
      status.projects.push(line); continue;
    }
    if (!(p.channels || []).length) { line.note = 'due, but no channels configured'; status.projects.push(line); continue; }

    if (dry) {
      line.note = 'DUE — would send now';
      line.channels = p.channels.map(c => `#${c.name} (${c.purpose})`);
      status.projects.push(line); continue;
    }

    log(`[auto-send] ${p.name}: sending to ${p.channels.length} channel(s)`);
    const r = await sendProjectNotifications(p.id, new Date(), null, 'auto');
    const anyOk = (r.results || []).some(x => x.ok);
    if (anyOk) { p.auto_last_sent = today; save(); }
    line.note = anyOk ? 'sent' : 'all channels failed — will retry on next ping';
    line.results = r.results;
    log('[auto-send] result:', JSON.stringify(r.results));
    status.projects.push(line);
  }
  if (!status.projects.length) status.note = 'No projects have automatic sending enabled';
  return status;
}

function startScheduler(log = console.log) {
  setInterval(() => runDueSchedules(log).catch(e => log('[auto-send] error:', e.message)), 60 * 1000);
}

module.exports = { startScheduler, runDueSchedules };
