// Notification window logic, template rendering, and Slack delivery.
const { load, save } = require('./db');

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
  const data = await res.json();
  if (data && !data.ok && data.error === 'ratelimited') {
    data._retryAfter = parseInt(res.headers.get('retry-after') || '20', 10);
  }
  return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Post once; if Slack says "ratelimited", wait the time it asks for (up to 45s) and retry once.
async function postMessage(token, channel, text) {
  let r = await slackApi(token, 'chat.postMessage', { channel, text });
  if (!r.ok && r.error === 'ratelimited') {
    await sleep(Math.min(r._retryAfter || 20, 45) * 1000);
    r = await slackApi(token, 'chat.postMessage', { channel, text });
  }
  return r;
}

const looksLikeId = v => /^[CGD][A-Z0-9]{6,}$/i.test(v.replace(/^#/, ''));

// Turn raw Slack errors into instructions a person can act on.
function friendlyError(err, channelName) {
  const map = {
    not_in_channel: `the bot isn't in #${channelName} yet — open that channel in Slack and type /invite @YourBotName`,
    channel_not_found: `Slack can't find "${channelName}" — check the spelling; if it's a private channel, invite the bot first and use the channel ID (Slack: channel name → ⋯ → Copy channel ID) instead of the name`,
    ratelimited: 'Slack is rate-limiting the bot (too many requests recently) — leave it alone for ~10 minutes, then press Send once',
    invalid_auth: 'the bot token looks invalid — re-copy it from api.slack.com and update it in Settings',
    token_revoked: 'the bot token was revoked — reinstall the Slack app and paste the new token in Settings',
    account_inactive: 'the Slack app was uninstalled — reinstall it and update the token in Settings',
    is_archived: `#${channelName} is archived in Slack`,
    msg_too_long: 'the message is too long for Slack — shorten the template',
  };
  return map[err] || err;
}

// Rarely needed fallback: only used for private channels referenced by name.
// conversations.list is heavily rate-limited by Slack, so we avoid it whenever possible.
async function resolveChannelId(token, nameOrId) {
  const v = nameOrId.replace(/^#/, '');
  let cursor;
  do {
    const r = await slackApi(token, 'conversations.list',
      { limit: 1000, types: 'public_channel,private_channel', cursor });
    if (!r.ok) throw new Error(friendlyError(r.error, v));
    const hit = (r.channels || []).find(c => c.name === v);
    if (hit) return hit.id;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
  } while (cursor);
  throw new Error(friendlyError('channel_not_found', v));
}

// Post to one channel with as few Slack calls as possible:
// 1) use a cached/explicit channel ID, 2) post by #name directly,
// 3) only as a last resort look the ID up (and cache it for next time).
async function postToChannel(token, ch, text) {
  const name = ch.name.replace(/^#/, '');
  let target = ch.resolved_id || (looksLikeId(name) ? name : null);
  if (target) {
    const r = await postMessage(token, target, text);
    if (r.ok) return r;
    if (r.error !== 'channel_not_found') throw new Error(friendlyError(r.error, name));
    ch.resolved_id = null; save(); // cached ID went stale (channel recreated?) — retry by name below
  }
  let r = await postMessage(token, '#' + name, text);
  if (r.ok) { if (r.channel) { ch.resolved_id = r.channel; save(); } return r; }
  if (r.error !== 'channel_not_found') throw new Error(friendlyError(r.error, name));
  const id = await resolveChannelId(token, name);
  ch.resolved_id = id; save();
  r = await postMessage(token, id, text);
  if (!r.ok) throw new Error(friendlyError(r.error, name));
  return r;
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
  let first = true;
  for (const m of targets) {
    if (!first) await sleep(1200); // pace multi-channel sends so Slack never sees a burst
    first = false;
    if (!m.workspace || !m.workspace.bot_token) {
      results.push({ channel: m.channel.name, ok: false, error: 'No workspace / bot token configured for this channel' });
      continue;
    }
    try {
      const text = m.text.replaceAll('@here', '<!here>').replaceAll('@channel', '<!channel>');
      await postToChannel(m.workspace.bot_token, m.channel, text);
      results.push({ channel: m.channel.name, workspace: m.workspace.name, ok: true, error: null });
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
