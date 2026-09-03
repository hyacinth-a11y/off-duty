const express = require('express');
const path = require('path');
const { load, save, nextId, DEFAULT_EXTERNAL_TEMPLATE, DEFAULT_INTERNAL_TEMPLATE } = require('./db');
const { buildMessages, sendProjectNotifications, projectReport, reportingWindow } = require('./notify');
const { startScheduler } = require('./scheduler');

const app = express();
app.use(express.json());

// Optional protection for public deployments: set APP_PASSWORD in the environment
// and the whole app (UI + API) requires it via HTTP Basic Auth.
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/api/cron') return next(); // guarded by its own CRON_KEY below
    if (req.path === '/api/calendar.ics') return next(); // guarded by its own feed key below
    const hdr = req.headers.authorization || '';
    const [, b64] = hdr.split(' ');
    const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Off Duty"').status(401).send('Password required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

const db = () => load();
const ok = (res, data) => res.json(data ?? { ok: true });

// ---------------- workspaces ----------------
app.get('/api/workspaces', (req, res) => {
  // never leak full tokens to the browser
  ok(res, db().workspaces.map(w => ({ id: w.id, name: w.name, has_token: !!w.bot_token, token_hint: w.bot_token ? '…' + w.bot_token.slice(-4) : null })));
});
app.post('/api/workspaces', (req, res) => {
  const { name, bot_token } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const w = { id: nextId(), name, bot_token: bot_token || '' };
  db().workspaces.push(w); save();
  ok(res, { id: w.id });
});
app.put('/api/workspaces/:id', (req, res) => {
  const w = db().workspaces.find(x => x.id === +req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) w.name = req.body.name;
  if (req.body.bot_token) w.bot_token = req.body.bot_token; // only overwrite when a new token is supplied
  save(); ok(res);
});
app.delete('/api/workspaces/:id', (req, res) => {
  const d = db(); d.workspaces = d.workspaces.filter(x => x.id !== +req.params.id); save(); ok(res);
});

// ---------------- projects (Section 1) ----------------
// Projects are the source of truth for member↔project mapping. Whenever a
// project's roster changes, reconcile every member's time-off entries with it:
// on the roster → their entries gain this project; off the roster → they lose it.
// Clean up a project schedule object coming from the form.
function normalizeSched(s) {
  s = s || {};
  const type = ['weekly', 'biweekly', 'monthly', 'twicedates'].includes(s.type) ? s.type : 'weekly';
  const clampDom = n => Math.min(Math.max(parseInt(n, 10) || 1, 1), 31);
  return {
    enabled: !!s.enabled,
    type,
    dow: Math.min(Math.max(parseInt(s.dow, 10) || 0, 0), 6),
    day: clampDom(s.day),
    day1: clampDom(s.day1),
    day2: clampDom(s.day2),
    time: /^\d{2}:\d{2}$/.test(s.time || '') ? s.time : '09:00',
  };
}

function syncTimeoffsWithRoster(project) {
  const d = db();
  for (const t of d.timeoffs) {
    const inRoster = (project.member_ids || []).includes(t.member_id);
    const has = t.project_ids.includes(project.id);
    if (inRoster && !has) t.project_ids.push(project.id);
    else if (!inRoster && has) t.project_ids = t.project_ids.filter(id => id !== project.id);
  }
}

app.get('/api/projects', (req, res) => ok(res, db().projects));
app.post('/api/projects', (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Project name is required' });
  const p = {
    id: nextId(),
    created_at: new Date().toISOString(),
    jira_name: b.jira_name || '',
    manager: b.manager || '',
    name: b.name,
    workspace_id: b.workspace_id || null,
    type: b.type === 'external' ? 'external' : 'internal',
    notify_via_email: !!b.notify_via_email,
    contacts: (b.contacts || []).filter(Boolean),
    sched: normalizeSched(b.sched),
    sched_last_sent: null,
    channels: (b.channels || []).filter(c => c.name || c.webhook_url).map(c => ({ id: nextId(), name: c.name || 'via-webhook', workspace_id: c.workspace_id || null, purpose: c.purpose === 'external' ? 'external' : 'internal', webhook_url: c.webhook_url || '' })),
    member_ids: b.member_ids || [],
  };
  db().projects.push(p); syncTimeoffsWithRoster(p); save(); ok(res, { id: p.id });
});
app.put('/api/projects/:id', (req, res) => {
  const p = db().projects.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  Object.assign(p, {
    jira_name: b.jira_name ?? p.jira_name,
    manager: b.manager ?? p.manager ?? '',
    name: b.name ?? p.name,
    workspace_id: b.workspace_id !== undefined ? b.workspace_id : p.workspace_id,
    type: b.type ?? p.type,
    notify_via_email: b.notify_via_email !== undefined ? !!b.notify_via_email : p.notify_via_email,
    contacts: b.contacts ?? p.contacts,
    member_ids: b.member_ids ?? p.member_ids,
    sched: b.sched !== undefined ? normalizeSched(b.sched) : (p.sched || normalizeSched(null)),
  });
  if (b.channels) {
    const prevById = Object.fromEntries((p.channels || []).map(c => [c.id, c]));
    p.channels = b.channels.filter(c => c.name || c.webhook_url).map(c => {
      const prev = (c.id && prevById[c.id]) || {};
      const name = c.name || 'via-webhook';
      return {
        id: c.id || nextId(),
        name,
        workspace_id: c.workspace_id || null,
        purpose: c.purpose === 'external' ? 'external' : 'internal',
        webhook_url: c.webhook_url || '',
        // keep send history across edits
        last_sent_at: prev.last_sent_at || null,
        last_sent_via: prev.last_sent_via || null,
        // keep the cached Slack channel ID only if the channel name didn't change
        resolved_id: prev.name === name ? (prev.resolved_id || null) : null,
      };
    });
  }
  syncTimeoffsWithRoster(p);
  save(); ok(res);
});
app.delete('/api/projects/:id', (req, res) => {
  const d = db(); const id = +req.params.id;
  d.projects = d.projects.filter(x => x.id !== id);
  d.timeoffs.forEach(t => t.project_ids = t.project_ids.filter(pid => pid !== id));
  d.schedules = d.schedules.filter(s => s.project_id !== id);
  save(); ok(res);
});

// Archive / restore. Archiving hides a project from the day-to-day sections and
// stops its automatic sending, but keeps all of its data so it can be restored.
app.post('/api/projects/:id/archive', (req, res) => {
  const p = db().projects.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  p.archived = true;
  p.archived_at = new Date().toISOString();
  save(); ok(res, p);
});

app.post('/api/projects/:id/restore', (req, res) => {
  const p = db().projects.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  p.archived = false;
  p.archived_at = null;
  save(); ok(res, p);
});

// ---------------- saved People views (filters) ----------------
app.get('/api/views', (req, res) => ok(res, db().views || []));
app.post('/api/views', (req, res) => {
  const d = db();
  d.views = d.views || [];
  const v = { id: nextId(), name: (req.body.name || 'Untitled view').trim(), member_ids: req.body.member_ids || [] };
  d.views.push(v); save(); ok(res, v);
});
app.put('/api/views/:id', (req, res) => {
  const v = (db().views || []).find(x => x.id === +req.params.id);
  if (!v) return res.status(404).json({ error: 'View not found' });
  if (req.body.name !== undefined) v.name = req.body.name.trim();
  if (Array.isArray(req.body.member_ids)) v.member_ids = req.body.member_ids;
  save(); ok(res, v);
});
app.delete('/api/views/:id', (req, res) => {
  const d = db();
  d.views = (d.views || []).filter(x => x.id !== +req.params.id);
  save(); ok(res);
});

// ---------------- members (Section 2) ----------------
// People fields. `status` is the original hand-entered kind and still works for
// anyone not synced from BambooHR; `division` is what BambooHR calls the
// employment status ("AE PH", "Independent Contractor", ...).
const PERSON_FIELDS = ['job_title', 'department', 'division', 'location', 'work_email', 'status'];
app.get('/api/members', (req, res) => ok(res, db().members));
app.post('/api/members', (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  const m = { id: nextId(), name: b.name };
  for (const f of PERSON_FIELDS) m[f] = b[f] || '';
  db().members.push(m); save(); ok(res, { id: m.id });
});
app.put('/api/members/:id', (req, res) => {
  const m = db().members.find(x => x.id === +req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) m.name = req.body.name;
  for (const f of PERSON_FIELDS) if (req.body[f] !== undefined) m[f] = req.body[f];
  save(); ok(res);
});
app.delete('/api/members/:id', (req, res) => {
  const d = db(); const id = +req.params.id;
  d.members = d.members.filter(x => x.id !== id);
  d.timeoffs = d.timeoffs.filter(t => t.member_id !== id);
  d.projects.forEach(p => p.member_ids = (p.member_ids || []).filter(mid => mid !== id));
  save(); ok(res);
});

// Merge one person into another: everything attached to `from` moves to the
// person in the URL, then the duplicate is removed. Used to clean up when a
// BambooHR sync creates a second record for someone already in the app.
app.post('/api/members/:id/merge', (req, res) => {
  const d = db();
  const keepId = +req.params.id, fromId = +req.body.from_id;
  const keep = d.members.find(m => m.id === keepId);
  const from = d.members.find(m => m.id === fromId);
  if (!keep || !from) return res.status(404).json({ error: 'Person not found' });
  if (keepId === fromId) return res.status(400).json({ error: 'Cannot merge someone into themselves' });

  // time-off entries move across (skip exact duplicates of the same dates)
  let movedOff = 0;
  for (const t of d.timeoffs) {
    if (t.member_id !== fromId) continue;
    const clash = d.timeoffs.some(x => x.member_id === keepId && x.start_date === t.start_date && x.end_date === t.end_date);
    if (clash) { t._drop = true; continue; }
    t.member_id = keepId; movedOff++;
  }
  const dropped = d.timeoffs.filter(t => t._drop).length;
  d.timeoffs = d.timeoffs.filter(t => !t._drop);

  // project rosters
  let movedProjects = 0;
  for (const p of d.projects) {
    const ids = p.member_ids || [];
    if (!ids.includes(fromId)) continue;
    p.member_ids = [...new Set(ids.map(x => (x === fromId ? keepId : x)))];
    movedProjects++;
  }

  // saved views
  for (const v of (d.views || [])) {
    const ids = v.member_ids || [];
    if (ids.includes(fromId)) v.member_ids = [...new Set(ids.map(x => (x === fromId ? keepId : x)))];
  }

  // fill any blank details on the kept record from the one being removed
  for (const f of ['job_title', 'department', 'division', 'location', 'work_email', 'bamboo_id', 'status']) {
    if (!keep[f] && from[f]) keep[f] = from[f];
  }

  d.members = d.members.filter(m => m.id !== fromId);
  save();
  ok(res, { kept: keep.name, removed: from.name, movedOff, dropped, movedProjects });
});

// ---------------- holidays (Section 3) ----------------
app.get('/api/holidays', (req, res) => ok(res, db().holidays));
app.post('/api/holidays', (req, res) => {
  const { name, date, location } = req.body;
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !['US', 'PH'].includes(location))
    return res.status(400).json({ error: 'Name, date (YYYY-MM-DD) and location (US/PH) are required' });
  const h = { id: nextId(), name, date, location };
  db().holidays.push(h); save(); ok(res, { id: h.id });
});
app.put('/api/holidays/:id', (req, res) => {
  const h = db().holidays.find(x => x.id === +req.params.id);
  if (!h) return res.status(404).json({ error: 'Not found' });
  Object.assign(h, {
    name: req.body.name ?? h.name,
    date: req.body.date ?? h.date,
    location: ['US', 'PH'].includes(req.body.location) ? req.body.location : h.location,
  });
  save(); ok(res);
});
app.delete('/api/holidays/:id', (req, res) => {
  const d = db(); d.holidays = d.holidays.filter(x => x.id !== +req.params.id); save(); ok(res);
});

// ---------------- time off (Section 4) ----------------
app.get('/api/timeoffs', (req, res) => ok(res, db().timeoffs));
app.post('/api/timeoffs', (req, res) => {
  const b = req.body;
  const member = db().members.find(m => m.id === +b.member_id);
  if (!member) return res.status(400).json({ error: 'Pick a team member (add them in Team Members first)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) return res.status(400).json({ error: 'Start date is required' });
  const end = b.end_date && /^\d{4}-\d{2}-\d{2}$/.test(b.end_date) ? b.end_date : b.start_date;
  const t = {
    id: nextId(), member_id: member.id,
    start_date: b.start_date, end_date: end < b.start_date ? b.start_date : end,
    status: b.status === 'approved' ? 'approved' : 'pending',
    project_ids: (b.project_ids || []).map(Number),
    note: b.note || '',
  };
  db().timeoffs.push(t); save(); ok(res, { id: t.id });
});
app.put('/api/timeoffs/:id', (req, res) => {
  const t = db().timeoffs.find(x => x.id === +req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  Object.assign(t, {
    member_id: b.member_id !== undefined ? +b.member_id : t.member_id,
    start_date: b.start_date ?? t.start_date,
    end_date: b.end_date ?? t.end_date,
    status: ['pending', 'approved'].includes(b.status) ? b.status : t.status,
    project_ids: b.project_ids ? b.project_ids.map(Number) : t.project_ids,
    note: b.note ?? t.note,
  });
  if (t.end_date < t.start_date) t.end_date = t.start_date;
  save(); ok(res);
});
app.delete('/api/timeoffs/:id', (req, res) => {
  const d = db(); d.timeoffs = d.timeoffs.filter(x => x.id !== +req.params.id); save(); ok(res);
});

// ---------------- project view (Section 5) ----------------
app.get('/api/window', (req, res) => ok(res, reportingWindow()));
app.get('/api/projects/:id/report', (req, res) => {
  const r = projectReport(+req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  ok(res, r);
});
app.get('/api/projects/:id/preview', (req, res) => {
  const b = buildMessages(+req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  ok(res, { messages: b.messages.map(m => ({ channel: m.channel, workspace: m.workspace ? m.workspace.name : null, text: m.text })), emailFallback: b.emailFallback });
});
app.post('/api/projects/:id/send', async (req, res) => {
  ok(res, await sendProjectNotifications(+req.params.id, new Date(), req.body && req.body.channel_id ? +req.body.channel_id : null));
});

// ---------------- schedules ----------------
app.get('/api/schedules', (req, res) => ok(res, db().schedules));
app.post('/api/schedules', (req, res) => {
  const b = req.body;
  if (!db().projects.find(p => p.id === +b.project_id)) return res.status(400).json({ error: 'Unknown project' });
  if (!/^\d{2}:\d{2}$/.test(b.time || '') || b.day === undefined) return res.status(400).json({ error: 'Day and time (HH:MM) are required' });
  const s = { id: nextId(), project_id: +b.project_id, day: +b.day, time: b.time, enabled: b.enabled !== false, last_sent: null };
  db().schedules.push(s); save(); ok(res, { id: s.id });
});
app.put('/api/schedules/:id', (req, res) => {
  const s = db().schedules.find(x => x.id === +req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  Object.assign(s, {
    day: b.day !== undefined ? +b.day : s.day,
    time: b.time ?? s.time,
    enabled: b.enabled !== undefined ? !!b.enabled : s.enabled,
  });
  save(); ok(res);
});
app.delete('/api/schedules/:id', (req, res) => {
  const d = db(); d.schedules = d.schedules.filter(x => x.id !== +req.params.id); save(); ok(res);
});

// ---------------- external cron trigger ----------------
// An external pinger (cron-job.org, GitHub Actions, Vercel cron, ...) hits
// GET /api/cron?key=CRON_KEY on a schedule. This wakes the app on free hosting
// and fires any schedules that are due today and not yet sent. Safe to ping
// repeatedly — each schedule sends at most once per day.
// Subscribable calendar feed for Google/Outlook/Apple Calendar.
// Guarded by FEED_KEY (or CRON_KEY if that isn't set) since calendar apps can't
// sign in past the app password.
app.get('/api/calendar.ics', (req, res) => {
  const { buildIcs, feedKey } = require('./ics');
  const key = feedKey();
  if (!key) return res.status(503).type('text/plain').send('No FEED_KEY or CRON_KEY set on the server');
  if ((req.query.key || '') !== key) return res.status(403).type('text/plain').send('Wrong or missing key');
  try {
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'inline; filename="off-duty.ics"');
    res.set('Cache-Control', 'public, max-age=1800');
    res.send(buildIcs());
  } catch (e) { res.status(500).type('text/plain').send(e.message); }
});

app.all('/api/cron', async (req, res) => {
  if (!process.env.CRON_KEY) return res.status(503).json({ error: 'CRON_KEY is not set on the server' });
  if ((req.query.key || '') !== process.env.CRON_KEY) return res.status(403).json({ error: 'Wrong or missing key' });
  const dry = req.query.dry === '1';
  const verbose = req.query.verbose === '1';
  const { runDueSchedules } = require('./scheduler');

  // When YOU ask for a report (dry run or verbose) we wait and return it.
  if (dry || verbose) {
    try { return ok(res, await runDueSchedules(console.log, dry)); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Normal pings from cron-job.org: answer straight away. Sending can take far
  // longer than the pinger's 30s timeout (Slack calls are paced 1.2s apart), and
  // a timeout counts as a failure — enough failures and the job gets disabled.
  // The scheduler's own lock stops overlapping runs, so this is safe.
  res.json({ ok: true, queued: true });
  runDueSchedules(console.log, false).catch(e => console.error('[auto-send] error:', e.message));
});

// ---------------- BambooHR sync ----------------
const { syncFromBamboo, isConfigured: bambooConfigured } = require('./bamboo');
app.get('/api/bamboo/status', (req, res) => ok(res, { configured: bambooConfigured() }));
app.post('/api/bamboo/sync-people', async (req, res) => {
  const { syncPeople } = require('./bamboo');
  ok(res, await syncPeople(req.query.dry === '1'));
});
app.post('/api/bamboo/sync', async (req, res) => {
  ok(res, await syncFromBamboo(req.query.dry === '1'));
});

// ---------------- Jira sync ----------------
const { syncFromJira, isConfigured: jiraConfigured } = require('./jira');
app.get('/api/jira/status', (req, res) => ok(res, { configured: jiraConfigured() }));
app.post('/api/jira/sync', async (req, res) => {
  ok(res, await syncFromJira(req.query.dry === '1'));
});

// ---------------- settings ----------------
app.get('/api/settings', (req, res) => ok(res, db().settings));
app.put('/api/settings', (req, res) => {
  const s = db().settings; const b = req.body;
  if (b.timezone) s.timezone = b.timezone;
  if (b.location_map && typeof b.location_map === 'object') s.location_map = b.location_map;
  if (b.division_holidays && typeof b.division_holidays === 'object') s.division_holidays = b.division_holidays;
  if (b.internal_template !== undefined) s.internal_template = b.internal_template || DEFAULT_INTERNAL_TEMPLATE;
  if (b.external_template !== undefined) s.external_template = b.external_template || DEFAULT_EXTERNAL_TEMPLATE;
  save(); ok(res);
});

const PORT = process.env.PORT || 3000;
const { initStore } = require('./db');
initStore().then(() => {
  app.listen(PORT, () => {
    console.log(`Time-off app running on http://localhost:${PORT}`);
    startScheduler();
  });
}).catch(e => { console.error('Failed to initialize storage:', e.message); process.exit(1); });
