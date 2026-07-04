// Checks once a minute whether any enabled schedule matches the current
// weekday + time (in the configured timezone) and sends that project's
// notifications. `last_sent` guards against double-sends within a minute.
const { load, save } = require('./db');
const { sendProjectNotifications, partsInTz } = require('./notify');

function startScheduler(log = console.log) {
  setInterval(async () => {
    try {
      const db = load();
      const tz = db.settings.timezone || 'Asia/Manila';
      const now = new Date();
      const { dow, hm, y, m, d } = partsInTz(now, tz);
      const stamp = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${hm}`;
      for (const s of db.schedules) {
        if (!s.enabled || s.day !== dow || s.time !== hm || s.last_sent === stamp) continue;
        s.last_sent = stamp;
        save();
        log(`[scheduler] sending notifications for project ${s.project_id} (${stamp} ${tz})`);
        const r = await sendProjectNotifications(s.project_id, now);
        log('[scheduler] result:', JSON.stringify(r.results));
      }
    } catch (e) {
      log('[scheduler] error:', e.message);
    }
  }, 30 * 1000);
}

module.exports = { startScheduler };
