// Project sync from the Portfolio app (Supabase-backed), replacing Jira as the
// source of projects and their statuses.
//
// Tickets keep the original Jira-style key ("POC-71"), which is the same value
// Off Duty already stores as jira_key — so existing projects stay linked and no
// data migration is needed.
//
// Config (set in Render):
//   PORTFOLIO_URL      e.g. https://rwwjeasedyttjstsqfow.supabase.co
//   PORTFOLIO_KEY      the Supabase publishable (anon) key
//   PORTFOLIO_MIN_NUMBER  optional, defaults to 82 — tickets below this number
//                         can still link to existing projects and update their
//                         status, they just won't be imported as new ones.
const { load, save, nextId } = require('./db');

function config() {
  return {
    base: (process.env.PORTFOLIO_URL || '').replace(/\/+$/, ''),
    key: (process.env.PORTFOLIO_KEY || '').trim(),
    minNumber: parseInt(process.env.PORTFOLIO_MIN_NUMBER || '82', 10),
  };
}

const isConfigured = () => !!(config().base && config().key);

async function sbGet(path) {
  const c = config();
  const res = await fetch(`${c.base}/rest/v1/${path}`, {
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Portfolio rejected the key — check PORTFOLIO_KEY, and that the table is readable');
  }
  if (!res.ok) throw new Error(`Portfolio request failed (${res.status})`);
  return res.json();
}

// Status lives on the ticket as a status_id; the readable name is in `statuses`.
async function fetchStatusNames() {
  const rows = await sbGet('statuses?select=id,name');
  return new Map((rows || []).map(s => [s.id, (s.name || '').trim()]));
}

async function fetchTickets() {
  const rows = await sbGet('tickets?select=id,key,number,title,description,status_id,work_type&order=number.asc&limit=1000');
  return Array.isArray(rows) ? rows : [];
}

// Pull "Project Manager: Jane Cruz" out of a plain-text description, if present.
function parseManager(description) {
  for (const raw of String(description || '').split('\n')) {
    const line = raw.replace(/[*_#]/g, '').trim();
    const m = line.match(/^project manager\s*:\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function syncFromPortfolio(dry = false) {
  if (!isConfigured()) {
    return { ok: false, error: 'Portfolio is not configured on the server (PORTFOLIO_URL / PORTFOLIO_KEY)' };
  }
  let tickets, statusNames;
  try {
    [tickets, statusNames] = await Promise.all([fetchTickets(), fetchStatusNames()]);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const c = config();
  const db = load();
  // jira_key is kept as the identifier — the portfolio uses the same "POC-71" keys
  const byKey = new Map(db.projects.filter(p => p.jira_key).map(p => [p.jira_key, p]));
  const byName = new Map();
  for (const p of db.projects) {
    if (p.jira_key) continue;                 // already linked
    for (const n of [p.jira_name, p.name]) {
      const k = norm(n);
      if (k && !byName.has(k)) byName.set(k, p);
    }
  }

  const created = [], restatused = [], linked = [], skipped = [];

  for (const t of tickets) {
    const key = (t.key || '').trim();
    if (!key) continue;
    const title = (t.title || '').trim() || key;
    const status = statusNames.get(t.status_id) || '';
    const manager = parseManager(t.description);
    const number = Number.isFinite(t.number) ? t.number : parseInt((key.split('-')[1] || '0'), 10);

    // already linked -> follow the status
    const existing = byKey.get(key);
    if (existing) {
      if (status && existing.status !== status) {
        restatused.push({ key, name: existing.name, from: existing.status || '(none)', to: status });
        if (!dry) existing.status = status;
      } else {
        skipped.push({ key, reason: 'already linked, status unchanged' });
      }
      continue;
    }

    // not linked yet, but a project of this name may already exist here
    const match = byName.get(norm(title));
    if (match) {
      linked.push({ key, name: match.name, status: status || '(none)', was: match.status || '(none)' });
      if (!dry) {
        match.jira_key = key;
        if (!match.jira_name) match.jira_name = title;
        if (status) match.status = status;
        if (!match.manager && manager) match.manager = manager;
      }
      byName.delete(norm(title));
      continue;
    }

    // brand new — only import if it's at or above the cutoff
    if (number < c.minNumber) { skipped.push({ key, reason: 'older than the import cutoff' }); continue; }
    if (dry) { created.push({ key, name: title, manager: manager || '(none)', status: status || '(none)' }); continue; }
    db.projects.push({
      id: nextId(),
      created_at: new Date().toISOString(),
      jira_key: key,
      jira_name: title,
      name: title,
      manager,
      status,
      notify_via_email: false,
      contacts: [],
      channels: [],
      member_ids: [],
      sched: { enabled: false, type: 'weekly', dow: 1, day: 1, day1: 1, day2: 15, time: '09:00' },
      sched_last_sent: null,
    });
    created.push({ key, name: title, manager: manager || '(none)', status: status || '(none)' });
  }

  if (!dry && (created.length || restatused.length || linked.length)) save();

  return {
    ok: true,
    mode: dry ? 'preview' : 'live',
    imported: dry ? 0 : created.length,
    would_import: dry ? created.length : undefined,
    created, restatused, linked,
    skipped_count: skipped.length,
    tickets_seen: tickets.length,
    statuses_seen: statusNames.size,
  };
}

// Diagnostic: what the portfolio returns and how it lines up with Off Duty.
async function debugPortfolio() {
  if (!isConfigured()) return { ok: false, error: 'Not configured (PORTFOLIO_URL / PORTFOLIO_KEY)' };
  try {
    const [tickets, statusNames] = await Promise.all([fetchTickets(), fetchStatusNames()]);
    const db = load();
    const byKey = new Map(db.projects.filter(p => p.jira_key).map(p => [p.jira_key, p]));
    return {
      ok: true,
      tickets_seen: tickets.length,
      statuses: [...statusNames.values()],
      sample: tickets.slice(0, 25).map(t => ({
        key: t.key,
        title: t.title,
        status: statusNames.get(t.status_id) || '(unknown status_id)',
        matched: byKey.has((t.key || '').trim()) ? `linked to "${byKey.get(t.key.trim()).name}"` : 'not linked yet',
      })),
      app_projects_without_key: db.projects.filter(p => !p.jira_key && !p.archived).map(p => p.name),
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { syncFromPortfolio, debugPortfolio, isConfigured };
