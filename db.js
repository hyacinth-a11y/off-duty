// Datastore with two modes:
//  - DATABASE_URL set (e.g. free Neon Postgres): data persists in Postgres,
//    which is required on free hosts like Render whose disks are wiped on restart.
//  - No DATABASE_URL: data lives in data/db.json (nice for running locally).
// Either way the app works with an in-memory object; save() persists it.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PG_URL = process.env.DATABASE_URL || '';

const DEFAULT_EXTERNAL_TEMPLATE = `Hi there! :wave:

The following members will be out for the month of {month}:
{ooo_list}

The following team members will observe a holiday:
{holiday_list}

We will do our best to accommodate your project needs during that time. @here`;

const DEFAULT_INTERNAL_TEMPLATE = `:calendar: *Time-off update — {project} — {month}*

Out of office:
{ooo_list}

Observing a holiday:
{holiday_list}

Please plan coverage accordingly.`;

const EMPTY = {
  workspaces: [],      // {id, name, bot_token}
  projects: [],        // {id, jira_name, name, workspace_id, type, notify_via_email, contacts:[], channels:[{id,name,workspace_id,purpose}], member_ids:[]}
  members: [],         // {id, name, status}
  holidays: [],        // {id, name, date, location:'US'|'PH'}
  timeoffs: [],        // {id, member_id, start_date, end_date, status, project_ids:[], note}
  schedules: [],       // {id, project_id, day, time, enabled, last_sent}
  settings: {
    timezone: 'Asia/Manila',
    external_template: DEFAULT_EXTERNAL_TEMPLATE,
    internal_template: DEFAULT_INTERNAL_TEMPLATE,
  },
  seq: 1,
};

let db = null;
let pool = null;

function backfill(d) {
  for (const k of Object.keys(EMPTY)) if (d[k] === undefined) d[k] = JSON.parse(JSON.stringify(EMPTY[k]));
  for (const k of Object.keys(EMPTY.settings)) if (d.settings[k] === undefined) d.settings[k] = EMPTY.settings[k];
  return d;
}

// Must be awaited once at startup (server.js does this before listening).
async function initStore() {
  if (db) return db;
  if (PG_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: PG_URL,
      ssl: PG_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    await pool.query('CREATE TABLE IF NOT EXISTS appdata (id INT PRIMARY KEY, data JSONB NOT NULL)');
    const r = await pool.query('SELECT data FROM appdata WHERE id = 1');
    if (r.rows.length) {
      db = backfill(r.rows[0].data);
    } else {
      db = JSON.parse(JSON.stringify(EMPTY));
      await pool.query('INSERT INTO appdata (id, data) VALUES (1, $1)', [JSON.stringify(db)]);
    }
    console.log('Storage: Postgres (persistent)');
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) db = backfill(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    else { db = JSON.parse(JSON.stringify(EMPTY)); persistNow(); }
    console.log('Storage: local file ' + DB_FILE);
  }
  return db;
}

function load() {
  if (!db) throw new Error('Datastore not initialized — initStore() must run first');
  return db;
}

// Persist current state. Writes are coalesced so rapid edits don't pile up.
let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saving = saving.then(persistNow).catch(e => console.error('save failed:', e.message)); }, 120);
}

async function persistNow() {
  if (pool) {
    await pool.query('UPDATE appdata SET data = $1 WHERE id = 1', [JSON.stringify(db)]);
  } else {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }
}

function nextId() {
  return load().seq++;
}

module.exports = { initStore, load, save, nextId, DEFAULT_EXTERNAL_TEMPLATE, DEFAULT_INTERNAL_TEMPLATE };
