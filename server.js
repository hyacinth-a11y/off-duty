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
    auto_enabled: !!b.auto_enabled,
    auto_days: Array.isArray(b.auto_days) ? b.auto_days.map(Number).filter(n => n >= 0 && n <= 6) : [],
    auto_time: /^\d{2}:\d{2}$/.test(b.auto_time || '') ? b.auto_time : '09:00',
    auto_last_sent: null,
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
    auto_enabled: b.auto_enabled !== undefined ? !!b.auto_enabled : !!p.auto_enabled,
    auto_days: Array.isArray(b.auto_days) ? b.auto_days.map(Number).filter(n => n >= 0 && n <= 6) : (p.auto_days || []),
    auto_time: /^\d{2}:\d{2}$/.test(b.auto_time || '') ? b.auto_time : (p.auto_time || '09:00'),
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

// ---------------- members (Section 2) ----------------
const STATUSES = ['PH Employee', 'US Employee', 'Contractor'];
app.get('/api/members', (req, res) => ok(res, db().members));
app.post('/api/members', (req, res) => {
  const { name, status } = req.body;
  if (!name || !STATUSES.includes(status)) return res.status(400).json({ error: 'Name and a valid employment status are required' });
  const m = { id: nextId(), name, status };
  db().members.push(m); save(); ok(res, { id: m.id });
});
app.put('/api/members/:id', (req, res) => {
  const m = db().members.find(x => x.id === +req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) m.name = req.body.name;
  if (STATUSES.includes(req.body.status)) m.status = req.body.status;
  save(); ok(res);
});
app.delete('/api/members/:id', (req, res) => {
  const d = db(); const id = +req.params.id;
  d.members = d.members.filter(x => x.id !== id);
  d.timeoffs = d.timeoffs.filter(t => t.member_id !== id);
  d.projects.forEach(p => p.member_ids = (p.member_ids || []).filter(mid => mid !== id));
  save(); ok(res);
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
app.all('/api/cron', async (req, res) => {
  if (!process.env.CRON_KEY) return res.status(503).json({ error: 'CRON_KEY is not set on the server' });
  if ((req.query.key || '') !== process.env.CRON_KEY) return res.status(403).json({ error: 'Wrong or missing key' });
  try {
    const { runDueSchedules } = require('./scheduler');
    ok(res, await runDueSchedules(console.log, req.query.dry === '1'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- settings ----------------
app.get('/api/settings', (req, res) => ok(res, db().settings));
app.put('/api/settings', (req, res) => {
  const s = db().settings; const b = req.body;
  if (b.timezone) s.timezone = b.timezone;
  if (b.internal_template !== undefined) s.internal_template = b.internal_template || DEFAULT_INTERNAL_TEMPLATE;
  if (b.external_template !== undefined) s.external_template = b.external_template || DEFAULT_EXTERNAL_TEMPLATE;
  if (b.auto_enabled !== undefined) s.auto_enabled = !!b.auto_enabled;
  if (Array.isArray(b.auto_days)) s.auto_days = b.auto_days.map(Number).filter(n => n >= 0 && n <= 6);
  if (/^\d{2}:\d{2}$/.test(b.auto_time || '')) s.auto_time = b.auto_time;
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
