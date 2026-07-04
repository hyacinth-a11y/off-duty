// Notification window logic, template rendering, and Slack delivery.
const { load } = require('./db');

// ---------- date helpers (all in the configured timezone) ----------
function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: +p.year, m: +p.month, d: +p.day,
    hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}`,
    dow: days[p.weekday],
  };
}

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Reporting window: the current month. If today falls in the last 7 days of
// the month, extend the window through the first 7 days of the next month.
function reportingWindow(now = new Date()) {
  const tz = load().settings.timezone || 'Asia/Manila';
  const { y, m, d } = partsInTz(now, tz);
  const last = lastDayOfMonth(y, m);
  const start = ymd(y, m, 1);
  let end = ymd(y, m, last);
  let extended = false;
  if (d > last - 7) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    end = ymd(ny, nm, 7);
    extended = true;
  }
  const monthName = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return { start, end, monthName, extended, today: ymd(y, m, d) };
}

function fmtDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'short', day: 'numeric' });
}
function fmtRange(a, b) { return a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`; }

const HOLIDAY_STATUS = { 'PH Employee': 'PH', 'US Employee': 'US' }; // Contractors observe none

// ---------- gather what goes into a project's notification ----------
function projectReport(projectId, now = new Date()) {
  const db = load();
  const win = reportingWindow(now);
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return null;

  const memberById = Object.fromEntries(db.members.map(m => [m.id, m]));

  // OOO: approved time-off entries tagged with this project, overlapping the window
  const ooo = db.timeoffs
    .filter(t => t.status === 'approved'
      && t.project_ids.includes(projectId)
      && t.start_date <= win.end && t.end_date >= win.start)
    .map(t => ({ ...t, member: memberById[t.member_id] }))
    .filter(t => t.member)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  // Holidays inside the window
  const holidays = db.holidays
    .filter(h => h.date >= win.start && h.date <= win.end)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Who observes them: the project roster if one is set, otherwise all members
  const pool = (project.member_ids && project.member_ids.length)
    ? project.member_ids.map(id => memberById[id]).filter(Boolean)
    : db.members;

  const holidayGroups = holidays.map(h => ({
    ...h,
    members: pool.filter(m => HOLIDAY_STATUS[m.status] === h.location),
  })).filter(g => g.members.length);

  return { project, win, ooo, holidayGroups };
}

function renderTemplate(template, report) {
  const { project, win, ooo, holidayGroups } = report;
  const oooList = ooo.length
    ? ooo.map(t => `• ${t.member.name} — ${fmtRange(t.start_date, t.end_date)}`).join('\n')
    : '• No scheduled time off :tada:';
  const holidayList = holidayGroups.length
    ? holidayGroups.map(g =>
        `• ${fmtDate(g.date)} — ${g.name} (${g.location}): ${g.members.map(m => m.name).join(', ')}`
      ).join('\n')
    : '• No holidays in this period';
  const holidayDates = holidayGroups.length
    ? fmtRange(holidayGroups[0].date, holidayGroups[holidayGroups.length - 1].date)
    : '—';
  return template
    .replaceAll('{project}', project.name)
    .replaceAll('{month}', win.monthName + (win.extended ? ' (incl. first week of next month)' : ''))
    .replaceAll('{ooo_list}', oooList)
    .replaceAll('{holiday_list}', holidayList)
    .replaceAll('{holiday_dates}', holidayDates);
}

// ---------- Slack ----------
async function slackApi(token, method, payload) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function resolveChannelId(token, nameOrId) {
  const v = nameOrId.replace(/^#/, '');
  if (/^[CGD][A-Z0-9]{6,}$/i.test(v)) return v; // already an ID
  let cursor;
  do {
    const r = await slackApi(token, 'conversations.list',
      { limit: 1000, types: 'public_channel,private_channel', cursor });
    if (!r.ok) throw new Error(`conversations.list failed: ${r.error}`);
    const hit = (r.channels || []).find(c => c.name === v);
    if (hit) return hit.id;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
  } while (cursor);
  throw new Error(`Channel "${nameOrId}" not found in that workspace (is the bot invited?)`);
}

// Build the per-channel messages for a project (also used for previews)
function buildMessages(projectId, now = new Date()) {
  const db = load();
  const report = projectReport(projectId, now);
  if (!report) return null;
  const { project } = report;
  const msgs = (project.channels || []).map(ch => ({
    channel: ch,
    workspace: db.workspaces.find(w => w.id === ch.workspace_id) || null,
    text: renderTemplate(
      ch.purpose === 'external' ? db.settings.external_template : db.settings.internal_template,
      report
    ),
  }));
  const emailFallback = project.notify_via_email && !(project.channels || []).some(c => c.purpose === 'external')
    ? renderTemplate(db.settings.external_template, report)
    : null;
  return { report, messages: msgs, emailFallback };
}

async function sendProjectNotifications(projectId, now = new Date(), channelId = null) {
  const built = buildMessages(projectId, now);
  if (!built) return { ok: false, error: 'Project not found' };
  const targets = channelId ? built.messages.filter(m => m.channel.id === channelId) : built.messages;
  if (channelId && !targets.length) return { ok: false, error: 'Channel not found on this project' };
  const results = [];
  for (const m of targets) {
    if (!m.workspace || !m.workspace.bot_token) {
      results.push({ channel: m.channel.name, ok: false, error: 'No workspace / bot token configured for this channel' });
      continue;
    }
    try {
      const channelId = await resolveChannelId(m.workspace.bot_token, m.channel.name);
      const text = m.text.replaceAll('@here', '<!here>').replaceAll('@channel', '<!channel>');
      const r = await slackApi(m.workspace.bot_token, 'chat.postMessage', { channel: channelId, text });
      results.push({ channel: m.channel.name, workspace: m.workspace.name, ok: !!r.ok, error: r.ok ? null : r.error });
    } catch (e) {
      results.push({ channel: m.channel.name, workspace: m.workspace.name, ok: false, error: e.message });
    }
  }
  if (built.emailFallback && !channelId) {
    results.push({ channel: '(email — send manually)', ok: true, skipped: true });
  }
  return { ok: results.every(r => r.ok), results };
}

module.exports = { reportingWindow, projectReport, buildMessages, sendProjectNotifications, partsInTz, fmtRange, fmtDate };
