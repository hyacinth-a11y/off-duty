// Jira onboarding sync. Pulls issues from the POC project and creates a matching
// Off Duty project for each NEW ticket (matched by Jira key, so re-syncing never
// duplicates). Maps: summary → project name + jira_name; a "Project Manager:"
// line in the description → manager (blank if the template field is empty).
//
// Config via environment variables (set in Render):
//   JIRA_BASE_URL  e.g. https://jira-nclouds.atlassian.net
//   JIRA_EMAIL     the Atlassian account email that owns the API token
//   JIRA_TOKEN     an API token from id.atlassian.com
//   JIRA_PROJECT_KEY   optional, defaults to POC
//   JIRA_MIN_KEY_NUMBER optional, defaults to 82 (only import POC-82 and later)
const { load, save, nextId } = require('./db');

function config() {
  return {
    base: (process.env.JIRA_BASE_URL || '').replace(/\/+$/, ''),
    email: process.env.JIRA_EMAIL || '',
    token: process.env.JIRA_TOKEN || '',
    projectKey: process.env.JIRA_PROJECT_KEY || 'POC',
    minNumber: parseInt(process.env.JIRA_MIN_KEY_NUMBER || '82', 10),
  };
}

function isConfigured() {
  const c = config();
  return !!(c.base && c.email && c.token);
}

async function jiraGet(path) {
  const c = config();
  const auth = Buffer.from(`${c.email}:${c.token}`).toString('base64');
  const res = await fetch(`${c.base}/rest/api/3${path}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) throw new Error('Jira rejected the credentials — check JIRA_EMAIL and JIRA_TOKEN in Render');
  if (!res.ok) throw new Error(`Jira request failed (${res.status})`);
  return res.json();
}

// Flatten Atlassian Document Format (description) to plain text so we can scan lines.
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  let t = node.text || '';
  if (node.content) t += adfToText(node.content);
  // keep list items / paragraphs on their own lines
  if (['paragraph', 'listItem', 'bulletList', 'heading'].includes(node.type)) t += '\n';
  return t;
}

function parseManager(descriptionAdf) {
  const text = adfToText(descriptionAdf);
  // find a line like "Project Manager: Jane Cruz" (bold markers already stripped)
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*/g, '').trim();
    const m = line.match(/^project manager\s*:\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

const keyNumber = key => parseInt((key.split('-')[1] || '0'), 10);

// Pull candidate issues from the POC project (newest first), page through them.
async function fetchOnboardingIssues() {
  const c = config();
  const jql = encodeURIComponent(`project = ${c.projectKey} ORDER BY created DESC`);
  const issues = [];
  let startAt = 0;
  for (let page = 0; page < 10; page++) { // safety cap: 10 pages
    const data = await jiraGet(`/search?jql=${jql}&fields=summary,description&maxResults=100&startAt=${startAt}`);
    for (const it of (data.issues || [])) issues.push(it);
    if (startAt + (data.issues || []).length >= data.total) break;
    startAt += (data.issues || []).length;
    if (!(data.issues || []).length) break;
  }
  return issues;
}

// Main entry: create projects for new tickets. dry=true reports without creating.
async function syncFromJira(dry = false) {
  if (!isConfigured()) return { ok: false, error: 'Jira is not configured on the server (JIRA_BASE_URL / JIRA_EMAIL / JIRA_TOKEN)' };
  const c = config();
  const db = load();
  const existingKeys = new Set(db.projects.map(p => p.jira_key).filter(Boolean));

  let issues;
  try { issues = await fetchOnboardingIssues(); }
  catch (e) { return { ok: false, error: e.message }; }

  const created = [], skipped = [];
  for (const it of issues) {
    const key = it.key;
    if (keyNumber(key) < c.minNumber) { continue; } // before the starting point
    if (existingKeys.has(key)) { skipped.push({ key, reason: 'already imported' }); continue; }
    const summary = (it.fields.summary || '').trim() || key;
    const manager = parseManager(it.fields.description);
    if (dry) { created.push({ key, name: summary, manager: manager || '(none)' }); continue; }
    const p = {
      id: nextId(),
      created_at: new Date().toISOString(),
      jira_key: key,                 // used for de-duplication
      jira_name: summary,
      name: summary,
      manager,
      notify_via_email: false,
      contacts: [],
      channels: [],
      member_ids: [],
      auto_enabled: false,
      auto_days: [],
      auto_time: '09:00',
      auto_last_sent: null,
    };
    db.projects.push(p);
    existingKeys.add(key);
    created.push({ key, name: summary, manager: manager || '(none)' });
  }
  if (!dry && created.length) save();
  return {
    ok: true,
    mode: dry ? 'preview' : 'live',
    imported: dry ? 0 : created.length,
    would_import: dry ? created.length : undefined,
    created,
    skipped_count: skipped.length,
  };
}

module.exports = { syncFromJira, isConfigured };
