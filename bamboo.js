// BambooHR sync. Pulls approved time-off from BambooHR and keeps Off Duty's
// Time-Off Entries in step with it, so nobody has to type leave in twice.
//
// Config (set in Render):
//   BAMBOO_SUBDOMAIN   your company domain, e.g. "nclouds" for nclouds.bamboohr.com
//   BAMBOO_API_KEY     an API key from BambooHR (your name → API Keys → Create New Key)
//   BAMBOO_MONTHS_AHEAD  optional, defaults to 6
//
// WHO GETS SYNCED: only BambooHR employees whose name matches someone in your
// Team Members list. That list IS the filter — add a person to include them,
// leave them out to ignore them. Once matched, the BambooHR employee id is
// remembered on the member, so later renames and typos don't break the link.
//
// The API key inherits the permissions of whoever created it, so it can only
// see the time-off that person can see.
const { load, save, nextId } = require('./db');

function config() {
  return {
    subdomain: (process.env.BAMBOO_SUBDOMAIN || '').trim(),
    apiKey: (process.env.BAMBOO_API_KEY || '').trim(),
    monthsAhead: parseInt(process.env.BAMBOO_MONTHS_AHEAD || '6', 10),
  };
}

const isConfigured = () => !!(config().subdomain && config().apiKey);

// BambooHR rate-limits and occasionally returns 429/503; back off and retry.
async function bambooGet(path, attempt = 0) {
  const c = config();
  const auth = Buffer.from(`${c.apiKey}:x`).toString('base64');
  const url = `https://api.bamboohr.com/api/gateway.php/${encodeURIComponent(c.subdomain)}/v1${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('BambooHR rejected the credentials — check BAMBOO_SUBDOMAIN and BAMBOO_API_KEY');
  }
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    const wait = retryAfter ? retryAfter * 1000 : Math.min(2 ** attempt * 1000 + Math.random() * 500, 15000);
    await new Promise(r => setTimeout(r, wait));
    return bambooGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`BambooHR request failed (${res.status})`);
  return res.json();
}

const ymd = d => d.toISOString().slice(0, 10);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, ''); // for forgiving name matching

// Pull the who's-out list for the window we care about.
async function fetchWhosOut() {
  const c = config();
  const start = new Date();
  start.setDate(start.getDate() - 14);           // a little history, so recent edits land
  const end = new Date();
  end.setMonth(end.getMonth() + c.monthsAhead);
  const rows = await bambooGet(`/time_off/whos_out/?start=${ymd(start)}&end=${ymd(end)}`);
  return { rows: Array.isArray(rows) ? rows : [], from: ymd(start), to: ymd(end) };
}

// Main entry. dry=true reports what would change without touching anything.
async function syncFromBamboo(dry = false) {
  if (!isConfigured()) {
    return { ok: false, error: 'BambooHR is not configured on the server (BAMBOO_SUBDOMAIN / BAMBOO_API_KEY)' };
  }
  let fetched;
  try { fetched = await fetchWhosOut(); }
  catch (e) { return { ok: false, error: e.message }; }

  const db = load();
  const { rows, from, to } = fetched;

  // Match BambooHR employees to Team Members: by remembered id first, then name.
  const byBambooId = new Map();
  const byName = new Map();
  for (const m of db.members) {
    if (m.bamboo_id) byBambooId.set(String(m.bamboo_id), m);
    byName.set(norm(m.name), m);
  }

  const created = [], updated = [], unmatched = new Map(), removed = [];
  const seenKeys = new Set();

  for (const r of rows) {
    if (r.type !== 'timeOff') continue;           // holidays stay managed in Off Duty
    const empId = String(r.employeeId);
    const member = byBambooId.get(empId) || byName.get(norm(r.name));
    if (!member) {
      if (!unmatched.has(empId)) unmatched.set(empId, r.name);
      continue;                                   // not in Team Members = deliberately ignored
    }
    // remember the id so future syncs don't depend on the name
    if (!member.bamboo_id && !dry) member.bamboo_id = empId;

    const key = `bamboo-${r.id}`;
    seenKeys.add(key);
    const existing = db.timeoffs.find(t => t.bamboo_key === key);
    const label = `${member.name} — ${r.start} → ${r.end}`;

    if (existing) {
      if (existing.start_date !== r.start || existing.end_date !== r.end || existing.member_id !== member.id) {
        if (!dry) {
          existing.start_date = r.start;
          existing.end_date = r.end;
          existing.member_id = member.id;
        }
        updated.push(label);
      }
      continue;
    }
    // projects come from the member's rosters, same as adding an entry by hand
    const projectIds = db.projects.filter(p => !p.archived && (p.member_ids || []).includes(member.id)).map(p => p.id);
    if (!dry) {
      db.timeoffs.push({
        id: nextId(),
        member_id: member.id,
        start_date: r.start,
        end_date: r.end,
        status: 'approved',                       // who's out only lists approved leave
        project_ids: projectIds,
        note: '',
        bamboo_key: key,
      });
    }
    created.push(label);
  }

  // Anything previously synced that has vanished from BambooHR (cancelled) and
  // falls inside the window we just fetched should go too.
  for (const t of [...db.timeoffs]) {
    if (!t.bamboo_key) continue;                  // hand-made entries are never touched
    if (seenKeys.has(t.bamboo_key)) continue;
    if (t.end_date < from || t.start_date > to) continue;
    const who = (db.members.find(m => m.id === t.member_id) || {}).name || 'someone';
    removed.push(`${who} — ${t.start_date} → ${t.end_date}`);
    if (!dry) db.timeoffs = db.timeoffs.filter(x => x !== t);
  }

  if (!dry && (created.length || updated.length || removed.length)) save();

  return {
    ok: true,
    mode: dry ? 'preview' : 'live',
    window: `${from} → ${to}`,
    created, updated, removed,
    unmatched: [...unmatched.values()],
    counts: { created: created.length, updated: updated.length, removed: removed.length, unmatched: unmatched.size },
  };
}

module.exports = { syncFromBamboo, isConfigured };
