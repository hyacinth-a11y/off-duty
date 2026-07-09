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

// Reporting window: from TODAY through the end of the current month — anything
// that already fully passed is excluded, while ongoing time off (started earlier,
// still running) is kept because entries are matched by overlap. If today falls in
// the last 7 days of the month, the window extends through the first 7 days of
// the next month.
function reportingWindow(now = new Date()) {
  const tz = load().settings.timezone || 'Asia/Manila';
  const { y, m, d } = partsInTz(now, tz);
  const last = lastDayOfMonth(y, m);
  const start = ymd(y, m, d); // today — past items fall out of the window
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
  return new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
// Smart ranges: "July 14–16, 2026" · "July 30 – August 2, 2026" · "December 29, 2026 – January 2, 2027"
function fmtRange(a, b) {
  if (a === b) return fmtDate(a);
  const [ya, ma, da] = a.split('-').map(Number), [yb, mb, db] = b.split('-').map(Number);
  const mn = (m, y) => new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long' });
  if (ya === yb && ma === mb) return `${mn(ma, ya)} ${da}–${db}, ${ya}`;
  if (ya === yb) return `${mn(ma, ya)} ${da} – ${mn(mb, yb)} ${db}, ${ya}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}

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

  // Who observes them: only members assigned to this project (Projects section roster)
  const pool = (project.member_ids || []).map(id => memberById[id]).filter(Boolean);

  const holidayGroups = holidays.map(h => ({
    ...h,
    members: pool.filter(m => HOLIDAY_STATUS[m.status] === h.location),
  })).filter(g => g.members.length);

  return { project, win, ooo, holidayGroups };
}

function renderTemplate(template, report) {
  const { project, win, ooo, holidayGroups } = report;
  // Group by member: one line for a single entry, name + indented date bullets for several
  let oooList = '• No scheduled time off :tada:';
  if (ooo.length) {
    const byMember = new Map();
    for (const t of ooo) {
      if (!byMember.has(t.member_id)) byMember.set(t.member_id, { name: t.member.name, ranges: [] });
      byMember.get(t.member_id).ranges.push(fmtRange(t.start_date, t.end_date));
    }
    oooList = [...byMember.values()].map(m =>
      m.ranges.length === 1
        ? `• ${m.name} — ${m.ranges[0]}`
        : `• ${m.name}\n${m.ranges.map(r => `        ◦ ${r}`).join('\n')}`
    ).join('\n');
  }

  let out = template
    .replaceAll('{project}', project.name)
    .replaceAll('{month}', win.monthName + (win.extended ? ' (incl. first week of next month)' : ''))
    .replaceAll('{ooo_list}', oooList);

  if (holidayGroups.length) {
    const holidayList = holidayGroups.map(g =>
      `• ${fmtDate(g.date)} — ${g.name} (${g.location}): ${g.members.map(m => m.name).join(', ')}`
    ).join('\n');
    const holidayDates = fmtRange(holidayGroups[0].date, holidayGroups[holidayGroups.length - 1].date);
    out = out.replaceAll('{holiday_list}', holidayList).replaceAll('{holiday_dates}', holidayDates);
  } else {
    // No holidays: drop the {holiday_list} line AND the heading line directly above it
    const lines = out.split('\n');
    const idx = lines.findIndex(l => l.includes('{holiday_list}'));
    if (idx >= 0) {
      let from = idx;
      if (from > 0 && lines[from - 1].trim() !== '') from -= 1; // the heading, e.g. "Observing a holiday:"
      lines.splice(from, idx - from + 1);
      out = lines.join('\n');
    }
    out = out.replaceAll('{holiday_list}', '').replaceAll('{holiday_dates}', '—')
      .replace(/\n{3,}/g, '\n\n'); // tidy leftover blank lines
  }
  return out;
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

// Post once; if Slack says "ratelimited" with a short wait, honor it and retry once.
// If Slack demands a long wait, fail fast and tell the user exactly how long.
async function postMessage(token, channel, text) {
  let r = await slackApi(token, 'chat.postMessage', { channel, text });
  if (!r.ok && r.error === 'ratelimited') {
    const wait = r._retryAfter || 20;
    if (wait <= 45) {
      await sleep(wait * 1000);
      r = await slackApi(token, 'chat.postMessage', { channel, text });
    }
    if (!r.ok && r.error === 'ratelimited') {
      const mins = Math.ceil((r._retryAfter || wait) / 60);
      throw new Error(`Slack is rate-limiting the bot and asked us to wait ~${mins} minute(s). Don't press Send during that time — every attempt can extend the penalty. If this keeps happening, create a fresh Slack app and update the token in Settings.`);
    }
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

// Post via an Incoming Webhook URL (tied to one channel; no token or invite needed).
async function postWebhook(url, text) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (res.ok && body.trim() === 'ok') return;
  if (res.status === 429) throw new Error('Slack asked us to slow down — wait a minute and press Send again');
  const map = {
    no_service: 'this webhook was deleted in Slack — create a new webhook and paste the new URL into the project',
    no_team: 'this webhook belongs to a deleted workspace',
    channel_not_found: 'the channel behind this webhook no longer exists — create a new webhook',
    channel_is_archived: 'the channel behind this webhook is archived in Slack',
    invalid_payload: 'message formatting problem — check the template for unusual characters',
  };
  throw new Error(map[body.trim()] || `webhook error: ${body.trim() || res.status}`);
}

async function sendProjectNotifications(projectId, now = new Date(), channelId = null, via = 'manual') {
  const built = buildMessages(projectId, now);
  if (!built) return { ok: false, error: 'Project not found' };
  const targets = channelId ? built.messages.filter(m => m.channel.id === channelId) : built.messages;
  if (channelId && !targets.length) return { ok: false, error: 'Channel not found on this project' };
  const results = [];
  let first = true;
  for (const m of targets) {
    if (!first) await sleep(1200); // pace multi-channel sends so Slack never sees a burst
    first = false;
    const text = m.text.replaceAll('@here', '<!here>').replaceAll('@channel', '<!channel>');
    // Webhook channels: simplest and most reliable path — use it whenever present
    if (m.channel.webhook_url) {
      try {
        await postWebhook(m.channel.webhook_url, text);
        m.channel.last_sent_at = new Date().toISOString(); m.channel.last_sent_via = via; save();
        results.push({ channel: m.channel.name, via: 'webhook', ok: true, error: null });
      } catch (e) {
        results.push({ channel: m.channel.name, via: 'webhook', ok: false, error: e.message });
      }
      continue;
    }
    if (!m.workspace || !m.workspace.bot_token) {
      results.push({ channel: m.channel.name, ok: false, error: 'No webhook URL and no workspace bot token configured for this channel' });
      continue;
    }
    try {
      await postToChannel(m.workspace.bot_token, m.channel, text);
      m.channel.last_sent_at = new Date().toISOString(); m.channel.last_sent_via = via; save();
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
