/* Off Duty — frontend */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUSES = ['PH Employee', 'US Employee', 'Contractor'];

const S = { workspaces: [], projects: [], members: [], holidays: [], timeoffs: [], schedules: [], settings: {}, win: null };

// Searchable multi-select: type to filter, click to add. Everything added shows
// in an explicit "Added (N)" list below the search box, each removable with ×.
// Returns { get(), set(ids) }.
function multiSelect(mount, { options, selected = [], placeholder = 'Type a name to search…', noun = 'added' }) {
  let sel = [...selected];
  mount.classList.add('ms');
  mount.innerHTML = `<div class="ms-box"><input class="ms-input" placeholder="${esc(placeholder)}"></div><div class="ms-list" hidden></div><div class="ms-picked"></div>`;
  const input = $('.ms-input', mount), list = $('.ms-list', mount), picked = $('.ms-picked', mount);
  const byId = id => options.find(o => o.id === id);
  const renderChips = () => {
    picked.innerHTML = sel.length
      ? `<strong class="ms-count">Added (${sel.length}):</strong> ` + sel.map(id => {
          const o = byId(id);
          return o ? `<span class="ms-chip">${esc(o.label)}<button type="button" data-x="${id}" title="Remove">×</button></span>` : '';
        }).join('')
      : `<span class="muted small">None ${esc(noun)} yet — type above to search and click a result to add it.</span>`;
    picked.querySelectorAll('[data-x]').forEach(b => b.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      sel = sel.filter(i => i !== +b.dataset.x); renderChips(); renderList();
    });
  };
  const renderList = () => {
    const q = input.value.trim().toLowerCase();
    const items = options.filter(o => !sel.includes(o.id) && (!q || (o.label + ' ' + (o.sub || '')).toLowerCase().includes(q)));
    list.innerHTML = items.length
      ? items.map(o => `<div class="ms-item" data-id="${o.id}">＋ ${esc(o.label)}${o.sub ? ` <span class="muted small">· ${esc(o.sub)}</span>` : ''}</div>`).join('')
      : `<div class="ms-empty">${options.length ? 'No matches (or already added)' : 'Nothing to pick yet'}</div>`;
    list.querySelectorAll('.ms-item').forEach(el => el.onclick = e => {
      e.preventDefault(); e.stopPropagation(); // keep the list from being auto-hidden
      sel.push(+el.dataset.id); input.value = ''; renderChips(); renderList(); input.focus();
      list.hidden = false;
    });
  };
  input.oninput = () => { list.hidden = false; renderList(); }; // typing always shows fresh results
  input.onfocus = () => { list.hidden = false; renderList(); };
  input.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault(); // don't submit/close the form
      const first = list.querySelector('.ms-item');
      if (first && !list.hidden) first.click(); // Enter adds the top match
    } else if (e.key === 'Escape') { list.hidden = true; }
  };
  document.addEventListener('click', e => { if (mount.isConnected && !mount.contains(e.target)) list.hidden = true; });
  renderChips();
  return { get: () => [...sel], set: ids => { sel = [...ids]; renderChips(); renderList(); } };
}

// ---------------- night mode ----------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('#themeToggle'); if (b) b.innerHTML = t === 'dark' ? '☀️ <span>Day mode</span>' : '🌙 <span>Night mode</span>';
}
let theme = localStorage.getItem('offduty-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(theme);
$('#themeToggle').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('offduty-theme', theme); applyTheme(theme); };

// ---------------- search ----------------
const Q = () => (S._q || '').trim().toLowerCase();
const hit = (...vals) => !Q() || vals.some(v => String(v || '').toLowerCase().includes(Q()));
const noMatch = fallback => Q() ? `No matches for "${esc(S._q.trim())}".` : fallback;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function refresh() {
  [S.workspaces, S.projects, S.members, S.holidays, S.timeoffs, S.schedules, S.settings, S.win] =
    await Promise.all(['/workspaces', '/projects', '/members', '/holidays', '/timeoffs', '/schedules', '/settings', '/window'].map(p => api(p)));
  S._pvData = null; // invalidate Send Notif cache on data refresh
  $('#windowChip').textContent = `Notice window: ${fmt(S.win.start)} → ${fmt(S.win.end)}`;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false; t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 3200);
}

// Wrap a click handler so the button disables itself until the work finishes.
// Prevents accidental duplicate saves on slow connections.
function busyClick(btn, fn) {
  btn.onclick = async () => {
    if (btn.disabled) return;
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Saving…';
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };
}

function openModal(html, onMount) {
  const m = $('#modal');
  $('#modalBody').innerHTML = html;
  m.showModal();
  if (onMount) onMount($('#modalBody'));
}
function closeModal() { $('#modal').close(); }
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });

const memberName = id => (S.members.find(m => m.id === id) || {}).name || '(removed)';
const projectName = id => (S.projects.find(p => p.id === id) || {}).name || '(removed)';
const wsName = id => (S.workspaces.find(w => w.id === id) || {}).name || '—';
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); // alphabetical, by project/member name
const fmtDT = iso => new Date(iso).toLocaleString('en-US', { timeZone: (S.settings && S.settings.timezone) || 'Asia/Manila', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------------- dates: display as "July 5, 2026", accept typed input ----------------
const fmt = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); };
const fmtRange = (a, b) => {
  if (a === b) return fmt(a);
  const [ya, ma, da] = a.split('-').map(Number), [yb, mb, db] = b.split('-').map(Number);
  const mn = (m, y) => new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long' });
  if (ya === yb && ma === mb) return `${mn(ma, ya)} ${da}–${db}, ${ya}`;
  if (ya === yb) return `${mn(ma, ya)} ${da} – ${mn(mb, yb)} ${db}, ${ya}`;
  return `${fmt(a)} – ${fmt(b)}`;
};

const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
// Accepts: "July 5, 2026" · "jul 5" · "5 July 2026" · "7/5/2026" (M/D/Y) · "2026-07-05". Year defaults to the current year.
function parseDate(s) {
  s = String(s || '').trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  if (!s) return '';
  const mk = (y, m, d) => { y = +y; m = +m; d = +d; if (m < 1 || m > 12 || d < 1 || d > 31) return ''; return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; };
  const thisYear = new Date().getFullYear();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return mk(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))) return mk(m[3].length === 2 ? '20' + m[3] : m[3], m[1], m[2]);
  if ((m = s.match(/^([a-z]+) (\d{1,2})(?: (\d{4}))?$/))) { const i = MONTH_NAMES.findIndex(x => x.startsWith(m[1])); if (i >= 0) return mk(m[3] || thisYear, i + 1, m[2]); }
  if ((m = s.match(/^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/))) { const i = MONTH_NAMES.findIndex(x => x.startsWith(m[2])); if (i >= 0) return mk(m[3] || thisYear, i + 1, m[1]); }
  return '';
}

// A date field you can TYPE into ("July 5, 2026", "jul 5", "7/5/2026") with a calendar picker beside it.
function dateField(cls, iso) {
  return `<span class="datewrap">
    <input type="text" class="date-text ${cls}" value="${iso ? fmt(iso) : ''}" placeholder="e.g. July 5, 2026" data-iso="${iso || ''}">
    <input type="date" class="date-native" value="${iso || ''}" title="Pick from calendar" tabindex="-1">
  </span>`;
}
function bindDateFields(body) {
  body.querySelectorAll('.datewrap').forEach(w => {
    const txt = $('.date-text', w), nat = $('.date-native', w);
    txt.addEventListener('blur', () => {
      const iso = parseDate(txt.value);
      txt.classList.toggle('bad', !!txt.value.trim() && !iso);
      if (iso) { txt.dataset.iso = iso; txt.value = fmt(iso); nat.value = iso; }
      else if (!txt.value.trim()) { txt.dataset.iso = ''; nat.value = ''; }
    });
    txt.addEventListener('input', () => txt.classList.remove('bad'));
    nat.onchange = () => { if (nat.value) { txt.dataset.iso = nat.value; txt.value = fmt(nat.value); txt.classList.remove('bad'); } };
  });
}
const dateVal = txt => parseDate(txt.value) || txt.dataset.iso || '';

/* ============================ PROJECTS ============================ */
function renderProjects(main) {
  const q = Q();
  // Match by project fields, contacts, channels — AND by any assigned member's name,
  // so typing a person shows every project they're on.
  const memberMatch = p => q && (p.member_ids || []).some(id => memberName(id).toLowerCase().includes(q));
  const plist = [...S.projects].filter(p => !p.archived).sort(byName).filter(p =>
    hit(
      p.name,
      p.jira_name,
      p.manager,
      (p.contacts || []).join(' '),
      (p.channels || []).map(c => c.name).join(' '),
      // the workspace each channel posts to, e.g. "AppEvolve" / "nClouds"
      [...new Set((p.channels || []).map(c => wsName(c.workspace_id)))].join(' ')
    ) || memberMatch(p));
  const isNew = p => p.created_at && (Date.now() - new Date(p.created_at).getTime()) < 7 * 864e5; // added within 7 days
  main.innerHTML = `
    <div class="section-head">
      <h1>Projects</h1><p>Source of truth for every project, its contacts, and its Slack channels. Search a member's name to see their projects.</p>
      <span class="spacer"></span>
      <button class="btn-ghost" id="jiraSync" title="Import new onboarding tickets from Jira">↧ Sync from Jira</button>
      <button class="btn-primary" id="addProject">Add project</button>
    </div>
    <div class="card">
      ${plist.length ? `<div class="table-scroll"><table class="projects-table"><thead><tr>
        <th>Project</th><th>Jira</th><th>Manager</th><th>Slack channels</th><th>Auto-send</th><th>Contacts</th><th></th>
      </tr></thead><tbody>
      ${plist.map(p => `<tr>
        <td><strong>${esc(p.name)}</strong>${isNew(p) ? ' <span class="badge-new">New</span>' : ''}${q && memberMatch(p) ? `<div class="muted small">members: ${esc((p.member_ids || []).map(memberName).join(', '))}</div>` : ''}</td>
        <td class="mono small">${esc(p.jira_name) || '—'}</td>
        <td class="small">${esc(p.manager || '') || '—'}</td>
        <td>${p.channels.length ? p.channels.map(c => `<div class="ch-line"><span class="hash">#${esc(c.name)}</span> <span class="muted small">· ${esc(wsName(c.workspace_id))}</span> <span class="chip ${c.purpose}">${c.purpose}</span></div>`).join('') : ''}
            ${p.notify_via_email && !p.channels.some(c => c.purpose === 'external') ? '<div class="ch-line"><span class="chip email">Email (manual)</span></div>' : ''}
            ${!p.channels.length && !p.notify_via_email ? '<span class="muted small">no channels yet</span>' : ''}</td>
        <td class="small">${(() => {
          const s = p.sched;
          if (!s || !s.enabled) return '—';
          const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const txt = s.type === 'weekly' ? `${D[s.dow]}`
            : s.type === 'biweekly' ? `1st & 3rd ${D[s.dow]}`
            : s.type === 'monthly' ? `day ${s.day}`
            : `day ${s.day1} & ${s.day2}`;
          return `${esc(txt)}<br>${esc(s.time || '09:00')}`;
        })()}</td>
        <td class="small contacts-cell" title="${esc(p.contacts.join(', '))}">${p.contacts.length ? esc(p.contacts.slice(0, 2).join(', ')) + (p.contacts.length > 2 ? ` <span class="chip">+${p.contacts.length - 2}</span>` : '') : '—'}</td>
        <td class="row-actions">
          <div class="act-wrap">
            <button class="act-toggle" title="Actions" aria-haspopup="true">
              <span>Options</span>
              <svg class="act-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div class="act-menu" hidden>
              <button type="button" data-edit="${p.id}">Edit</button>
              <button type="button" data-archive="${p.id}">Archive</button>
              <button type="button" class="danger" data-del="${p.id}">Delete</button>
            </div>
          </div>
        </td>
      </tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${noMatch('No projects yet. Add your first project to start building notices.')}</div>`}
    </div>`;
  $('#addProject').onclick = () => projectForm();
  $('#jiraSync').onclick = async () => {
    const btn = $('#jiraSync'); if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Checking Jira…';
    try {
      const status = await api('/jira/status');
      if (!status.configured) {
        toast('Jira isn\u2019t connected yet — add the Jira settings in Render first (ask Claude for the steps)', true);
        btn.disabled = false; btn.textContent = '↧ Sync from Jira'; return;
      }
      const preview = await api('/jira/sync?dry=1', 'POST');
      if (!preview.ok) { toast(preview.error, true); btn.disabled = false; btn.textContent = '↧ Sync from Jira'; return; }
      if (!preview.would_import) { toast('No new Jira tickets to import — you\u2019re all caught up ✓'); btn.disabled = false; btn.textContent = '↧ Sync from Jira'; return; }
      const list = preview.created.map(c => `• ${c.key} — ${c.name}`).join('\n');
      if (!confirm(`Import ${preview.would_import} new project(s) from Jira?\n\n${list}\n\nYou can fill in Slack channels and members afterward.`)) {
        btn.disabled = false; btn.textContent = '↧ Sync from Jira'; return;
      }
      btn.textContent = 'Importing…';
      const r = await api('/jira/sync', 'POST');
      if (r.ok) { await reload(`Imported ${r.imported} project(s) from Jira ✓`); }
      else { toast(r.error, true); btn.disabled = false; btn.textContent = '↧ Sync from Jira'; }
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = '↧ Sync from Jira'; }
  };
  // Row actions dropdown: one open at a time, closes on outside click or Esc
  const closeMenus = () => main.querySelectorAll('.act-menu').forEach(m => {
    m.hidden = true;
    m.previousElementSibling.classList.remove('open');
  });
  main.querySelectorAll('.act-toggle').forEach(btn => btn.onclick = e => {
    e.stopPropagation();
    const menu = btn.nextElementSibling;
    const wasOpen = !menu.hidden;
    closeMenus();
    if (wasOpen) return;
    menu.hidden = false;
    btn.classList.add('open');
    // flip above the button when there isn't room below
    menu.classList.remove('up');
    const r = menu.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) menu.classList.add('up');
  });
  main.querySelectorAll('.act-menu').forEach(m => m.onclick = e => e.stopPropagation());
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => projectForm(S.projects.find(p => p.id === +b.dataset.edit)));
  main.querySelectorAll('[data-archive]').forEach(b => b.onclick = async () => {
    const p = S.projects.find(x => x.id === +b.dataset.archive);
    if (!confirm(`Archive "${p.name}"?\n\nIt will be hidden from Projects, Send Notif and the time-off picker, and its automatic sending stops. Nothing is deleted — you can restore it any time from Settings.`)) return;
    await api('/projects/' + b.dataset.archive + '/archive', 'POST');
    await reload('Archived — restore it from Settings');
  });
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this project? Its schedules and time-off links will be removed too.')) return;
    await api('/projects/' + b.dataset.del, 'DELETE'); await reload('Deleted');
  });
}

function projectForm(p) {
  p = p || { name: '', jira_name: '', manager: '', notify_via_email: false, contacts: [], channels: [], member_ids: [] };
  const wsOpts = sel => `<option value="">— pick workspace —</option>` + S.workspaces.map(w => `<option value="${w.id}" ${w.id === sel ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  const contactRow = v => `<input type="text" class="contact" value="${esc(v)}" placeholder="Contact name" style="margin-bottom:6px">`;
  const sc = p.sched || { enabled: false, type: 'weekly', dow: 1, day: 1, day1: 1, day2: 15, time: '09:00' };
  const domOpts = sel => Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${+sel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');
  const channelRow = c => `<div class="channel-row" style="margin-bottom:12px;border:1px dashed var(--line);border-radius:8px;padding:8px">
      <input type="hidden" class="ch-id" value="${c.id || ''}">
      <div class="row">
        <input type="text" class="ch-name" value="${esc(c.name || '')}" placeholder="channel-name (label)">
        <select class="ch-ws">${wsOpts(c.workspace_id)}</select>
        <select class="ch-purpose"><option value="internal" ${c.purpose !== 'external' ? 'selected' : ''}>Internal</option><option value="external" ${c.purpose === 'external' ? 'selected' : ''}>External (client)</option></select>
        <button type="button" class="btn-danger ch-del" style="flex:0">✕</button>
      </div>
      <input type="text" class="ch-webhook" value="${esc(c.webhook_url || '')}" placeholder="Webhook URL (recommended): https://hooks.slack.com/services/…" style="margin-top:6px">
    </div>`;
  openModal(`
    <h2>${p.id ? 'Edit project' : 'Add project'}</h2>
    <div class="row">
      <label class="field"><span>Project name</span><input type="text" id="pName" value="${esc(p.name)}"></label>
      <label class="field"><span>Jira project name</span><input type="text" id="pJira" value="${esc(p.jira_name)}"></label>
    </div>
    <label class="field"><span>Project manager</span><input type="text" id="pManager" value="${esc(p.manager || '')}"></label>
    <label class="field"><span>Point of contacts (add as many as you need)</span>
      <div id="contacts">${(p.contacts.length ? p.contacts : ['']).map(contactRow).join('')}</div>
      <button type="button" class="btn-ghost" id="addContact">+ Add contact</button></label>
    <label class="field"><span>Slack channels — easiest: paste a <strong>Webhook URL</strong> per channel (Slack app → Incoming Webhooks → Add New Webhook → pick the channel). With a webhook, no bot invite or workspace token is needed; the name is just a label.</span>
      <div id="channels">${p.channels.map(channelRow).join('')}</div>
      <button type="button" class="btn-ghost" id="addChannel">+ Add channel</button></label>
    <label class="field" style="display:flex;gap:8px;align-items:center">
      <input type="checkbox" id="pEmail" ${p.notify_via_email ? 'checked' : ''} style="width:auto">
      <span style="margin:0">No external Slack channel — mark as <strong>Email</strong> (I'll notify the client manually)</span></label>
    <label class="field"><span>Automatic sending — when this schedule fires, the notice goes to <strong>all</strong> of this project's Slack channels. It skips silently if nobody is out and no holidays apply. You can always still press Send manually.</span>
      <label style="display:flex;gap:8px;align-items:center;font-weight:600;color:var(--ink);margin:6px 0"><input type="checkbox" id="sEnabled" ${sc.enabled ? 'checked' : ''} style="width:auto"> Enable automatic schedule</label>
      <div id="schedBody" style="display:${sc.enabled ? 'block' : 'none'}">
        <div class="row" style="align-items:flex-end;gap:8px">
          <label class="field" style="margin:0"><span>Frequency</span>
            <select id="sType">
              <option value="weekly" ${sc.type === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="biweekly" ${sc.type === 'biweekly' ? 'selected' : ''}>Bi-weekly (1st &amp; 3rd weekday)</option>
              <option value="monthly" ${sc.type === 'monthly' ? 'selected' : ''}>Monthly (one date)</option>
              <option value="twicedates" ${sc.type === 'twicedates' ? 'selected' : ''}>Twice a month (two dates)</option>
            </select></label>
          <label class="field" id="wrapDow" style="margin:0"><span>Weekday</span>
            <select id="sDow">${DAYS.map((d, i) => `<option value="${i}" ${+sc.dow === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="field" id="wrapDay" style="margin:0"><span>Day of month</span>
            <select id="sDay">${domOpts(sc.day)}</select></label>
          <label class="field" id="wrapDay1" style="margin:0"><span>1st date</span>
            <select id="sDay1">${domOpts(sc.day1)}</select></label>
          <label class="field" id="wrapDay2" style="margin:0"><span>2nd date</span>
            <select id="sDay2">${domOpts(sc.day2)}</select></label>
          <label class="field" style="margin:0"><span>Time (PH)</span><input type="time" id="sTime" value="${esc(sc.time || '09:00')}"></label>
        </div>
        <p class="muted small" style="margin:6px 0 0">Bi-weekly means the 1st and 3rd of the chosen weekday. If you pick day 31, months that are shorter fire on their last day instead.</p>
      </div>
    </label>
    <label class="field"><span>Team members on this project — from the Team Members section. This is the source of truth: it auto-fills projects on time-off entries and drives the holiday list.</span>
      <div id="pmSelect"></div></label>
    <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save project</button></div>
  `, body => {
    const pmMs = multiSelect($('#pmSelect', body), {
      options: S.members.map(m => ({ id: m.id, label: m.name, sub: m.status })),
      selected: p.member_ids || [],
      placeholder: 'Type a member name to add…',
    });
    $('#addContact', body).onclick = () => $('#contacts', body).insertAdjacentHTML('beforeend', contactRow(''));
    $('#addChannel', body).onclick = () => { $('#channels', body).insertAdjacentHTML('beforeend', channelRow({})); bindDel(); };
    const bindDel = () => body.querySelectorAll('.ch-del').forEach(x => x.onclick = () => x.closest('.channel-row').remove());
    bindDel();
    // show only the schedule fields that apply to the chosen frequency
    const syncSched = () => {
      $('#schedBody', body).style.display = $('#sEnabled', body).checked ? 'block' : 'none';
      const t = $('#sType', body).value;
      $('#wrapDow', body).style.display = (t === 'weekly' || t === 'biweekly') ? '' : 'none';
      $('#wrapDay', body).style.display = t === 'monthly' ? '' : 'none';
      $('#wrapDay1', body).style.display = t === 'twicedates' ? '' : 'none';
      $('#wrapDay2', body).style.display = t === 'twicedates' ? '' : 'none';
    };
    $('#sEnabled', body).onchange = syncSched;
    $('#sType', body).onchange = syncSched;
    syncSched();
    $('#mCancel', body).onclick = closeModal;
    busyClick($('#mSave', body), async () => {
      const payload = {
        name: $('#pName', body).value.trim(),
        jira_name: $('#pJira', body).value.trim(),
        manager: $('#pManager', body).value.trim(),
        notify_via_email: $('#pEmail', body).checked,
        contacts: [...body.querySelectorAll('.contact')].map(i => i.value.trim()).filter(Boolean),
        channels: [...body.querySelectorAll('.channel-row')].map(r => ({
          id: +$('.ch-id', r).value || undefined,
          name: $('.ch-name', r).value.trim().replace(/^#/, ''),
          workspace_id: +$('.ch-ws', r).value || null,
          purpose: $('.ch-purpose', r).value,
          webhook_url: $('.ch-webhook', r).value.trim(),
        })).filter(c => c.name || c.webhook_url),
        member_ids: pmMs.get(),
        sched: {
          enabled: $('#sEnabled', body).checked,
          type: $('#sType', body).value,
          dow: +$('#sDow', body).value,
          day: +$('#sDay', body).value,
          day1: +$('#sDay1', body).value,
          day2: +$('#sDay2', body).value,
          time: $('#sTime', body).value || '09:00',
        },
      };
      try {
        await (p.id ? api('/projects/' + p.id, 'PUT', payload) : api('/projects', 'POST', payload));
        closeModal(); await reload('Project saved');
      } catch (e) { toast(e.message, true); }
    });
  });
}

/* ============================ MEMBERS ============================ */
function renderMembers(main) {
  const mlist = [...S.members].sort(byName).filter(m => hit(m.name, m.status));
  main.innerHTML = `
    <div class="section-head">
      <h1>Team Members</h1><p>Source of truth for everyone in the company. Add people here before logging their time off.</p>
      <span class="spacer"></span><button class="btn-primary" id="addMember">Add member</button>
    </div>
    <div class="card">
      ${mlist.length ? `<table><thead><tr><th>Name</th><th>Employment status</th><th>Holidays that apply</th><th></th></tr></thead><tbody>
      ${mlist.map(m => `<tr>
        <td><strong>${esc(m.name)}</strong></td><td>${esc(m.status)}</td>
        <td class="small muted">${m.status === 'PH Employee' ? 'PH holidays' : m.status === 'US Employee' ? 'US holidays' : 'None (contractor)'}</td>
        <td><button class="btn-link" data-edit="${m.id}">Edit</button><button class="btn-danger" data-del="${m.id}">Delete</button></td>
      </tr>`).join('')}</tbody></table>` : `<div class="empty">${noMatch('No team members yet.')}</div>`}
    </div>`;
  const form = m => openModal(`
    <h2>${m.id ? 'Edit member' : 'Add member'}</h2>
    <label class="field"><span>Name</span><input type="text" id="mName" value="${esc(m.name || '')}"></label>
    <label class="field"><span>Employment status</span><select id="mStatus">${STATUSES.map(s => `<option ${m.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save member</button></div>
  `, body => {
    $('#mCancel', body).onclick = closeModal;
    busyClick($('#mSave', body), async () => {
      try {
        const payload = { name: $('#mName', body).value.trim(), status: $('#mStatus', body).value };
        await (m.id ? api('/members/' + m.id, 'PUT', payload) : api('/members', 'POST', payload));
        closeModal(); await reload('Member saved');
      } catch (e) { toast(e.message, true); }
    });
  });
  $('#addMember').onclick = () => form({});
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(S.members.find(m => m.id === +b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this member? Their time-off entries will be removed too.')) return;
    await api('/members/' + b.dataset.del, 'DELETE'); await reload('Deleted');
  });
}

/* ============================ HOLIDAYS ============================ */
function renderHolidays(main) {
  const years = [...new Set(S.holidays.map(h => h.date.slice(0, 4)))].sort();
  const year = S._holidayYear || years[years.length - 1] || String(new Date().getFullYear());
  S._holidayYear = year;
  const list = S.holidays.filter(h => h.date.startsWith(year) && hit(h.name)).sort((a, b) => a.date.localeCompare(b.date));
  const block = loc => {
    const rows = list.filter(h => h.location === loc);
    return `<div class="card"><h2>${loc === 'PH' ? '🇵🇭 Philippine holidays' : '🇺🇸 US holidays'} · ${esc(year)}</h2>
      ${rows.length ? `<table><thead><tr><th>Date</th><th>Holiday</th><th></th></tr></thead><tbody>
      ${rows.map(h => `<tr><td>${fmt(h.date)}</td><td>${esc(h.name)}</td>
        <td><button class="btn-link" data-edit="${h.id}">Edit</button><button class="btn-danger" data-del="${h.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No ${loc} holidays for ${esc(year)} yet.</div>`}</div>`;
  };
  main.innerHTML = `
    <div class="section-head">
      <h1>Holidays</h1>
      <p>Applies automatically: PH holidays to PH Employees, US holidays to US Employees.</p>
      <span class="spacer"></span>
      <select id="yearSel" style="width:auto">${[...new Set([...years, String(new Date().getFullYear()), String(new Date().getFullYear() + 1)])].sort().map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <button class="btn-primary" id="addHoliday">Add holiday</button>
    </div>
    ${block('PH')}${block('US')}`;
  $('#yearSel').onchange = e => { S._holidayYear = e.target.value; renderHolidays(main); };
  const form = h => openModal(`
    <h2>${h.id ? 'Edit holiday' : 'Add holiday'}</h2>
    <label class="field"><span>Holiday name</span><input type="text" id="hName" value="${esc(h.name || '')}"></label>
    <div class="row">
      <label class="field"><span>Date — type it (e.g. "July 5, 2026") or use the calendar</span>${dateField('hDate', h.date || '')}</label>
      <label class="field"><span>Location</span><select id="hLoc"><option value="PH" ${h.location === 'PH' ? 'selected' : ''}>Philippines</option><option value="US" ${h.location === 'US' ? 'selected' : ''}>United States</option></select></label>
    </div>
    <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save holiday</button></div>
  `, body => {
    bindDateFields(body);
    $('#mCancel', body).onclick = closeModal;
    busyClick($('#mSave', body), async () => {
      try {
        const payload = { name: $('#hName', body).value.trim(), date: dateVal($('.hDate', body)), location: $('#hLoc', body).value };
        await (h.id ? api('/holidays/' + h.id, 'PUT', payload) : api('/holidays', 'POST', payload));
        closeModal(); await reload('Holiday saved');
      } catch (e) { toast(e.message, true); }
    });
  });
  $('#addHoliday').onclick = () => form({});
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(S.holidays.find(h => h.id === +b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/holidays/' + b.dataset.del, 'DELETE'); await reload('Deleted'); });
}

/* ============================ TIME OFF ============================ */
function renderTimeoff(main) {
  const sortMode = S._toSort || 'date';
  const groupMode = S._toGroup || 'none';
  const rows = S.timeoffs.filter(t => hit(memberName(t.member_id), t.project_ids.map(projectName).join(' '))).sort(sortMode === 'name'
    ? (a, b) => memberName(a.member_id).localeCompare(memberName(b.member_id), undefined, { sensitivity: 'base' }) || a.start_date.localeCompare(b.start_date)
    : (a, b) => a.start_date.localeCompare(b.start_date) || memberName(a.member_id).localeCompare(memberName(b.member_id)));

  // One row renderer for every view. `skip` hides the column the list is grouped by.
  const rowHtml = (t, skip) => `<tr>
    ${skip === 'member' ? '' : `<td><strong>${esc(memberName(t.member_id))}</strong></td>`}
    <td class="nowrap">${fmtRange(t.start_date, t.end_date)}</td>
    ${skip === 'project' ? '' : `<td>${t.project_ids.map(id => `<span class="chip">${esc(projectName(id))}</span>`).join(' ') || '<span class="muted small">—</span>'}</td>`}
    <td><span class="badge ${t.status}">${t.status === 'approved' ? 'Approved' : 'Pending approval'}</span></td>
    <td class="small muted">${esc(t.note) || ''}</td>
    <td class="nowrap"><button class="btn-link" data-edit="${t.id}">Edit</button><button class="btn-danger" data-del="${t.id}">Delete</button></td>
  </tr>`;
  const tableHtml = (list, skip) => `<table><thead><tr>
    ${skip === 'member' ? '' : '<th>Member</th>'}<th>Dates</th>${skip === 'project' ? '' : '<th>Projects</th>'}<th>Status</th><th>Note</th><th></th>
  </tr></thead><tbody>${list.map(t => rowHtml(t, skip)).join('')}</tbody></table>`;

  // Build the grouped buckets when grouping is on
  let bodyHtml;
  if (!rows.length) {
    bodyHtml = `<div class="card"><div class="empty">${noMatch('No time-off entries yet. Only <strong>approved</strong> entries appear in Slack notices.')}</div></div>`;
  } else if (groupMode === 'none') {
    bodyHtml = `<div class="card">${tableHtml(rows, null)}</div>`;
  } else {
    const map = new Map();
    for (const t of rows) {
      const keys = groupMode === 'member'
        ? [t.member_id]
        : (t.project_ids.length ? t.project_ids : [null]); // an entry shows under each of its projects
      for (const k of keys) {
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(t);
      }
    }
    const label = k => k === null ? 'No project assigned' : (groupMode === 'member' ? memberName(k) : projectName(k));
    const groups = [...map.entries()]
      .map(([k, items]) => ({ k, items, label: label(k) }))
      .sort((a, b) => (a.k === null) - (b.k === null) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    bodyHtml = groups.map(g => {
      const approved = g.items.filter(t => t.status === 'approved').length;
      return `<details class="group-block" open>
        <summary>${esc(g.label)}
          <span class="muted small">— ${g.items.length} ${g.items.length === 1 ? 'entry' : 'entries'}${approved ? ` · ${approved} approved` : ''}</span>
        </summary>
        <div class="card group-card">${tableHtml(g.items, groupMode)}</div>
      </details>`;
    }).join('');
  }

  main.innerHTML = `
    <div class="section-head">
      <h1>Time-Off Entries</h1><p>The source of truth for requests. Members come from Team Members; projects come from Projects.</p>
      <span class="spacer"></span>
      <label class="small muted" style="display:flex;align-items:center;gap:6px">Group by
        <select id="toGroup" style="width:auto">
          <option value="none" ${groupMode === 'none' ? 'selected' : ''}>Nothing (flat list)</option>
          <option value="member" ${groupMode === 'member' ? 'selected' : ''}>Member</option>
          <option value="project" ${groupMode === 'project' ? 'selected' : ''}>Project</option>
        </select></label>
      <label class="small muted" style="display:flex;align-items:center;gap:6px">Sort by
        <select id="toSort" style="width:auto">
          <option value="date" ${sortMode === 'date' ? 'selected' : ''}>Time-off date (earliest first)</option>
          <option value="name" ${sortMode === 'name' ? 'selected' : ''}>Member name (A–Z)</option>
        </select></label>
      <button class="btn-primary" id="addTo">Add time-off entry</button>
    </div>
    ${bodyHtml}
    <p class="muted small">Heads-up: only entries marked <strong>Approved</strong> are included in Slack notifications. If someone isn't in the member dropdown, add them under Team Members first.</p>`;

  const form = t => {
    t = t || { member_id: '', start_date: '', end_date: '', status: 'pending', project_ids: [], note: '' };
    if (!S.members.length) return toast('Add team members first (Team Members section)', true);
    openModal(`
      <h2>${t.id ? 'Edit time-off entry' : 'Add time-off entry'}</h2>
      <label class="field"><span>Team member</span>
        <select id="tMember"><option value="">— pick member —</option>${S.members.map(m => `<option value="${m.id}" ${m.id === t.member_id ? 'selected' : ''}>${esc(m.name)} (${esc(m.status)})</option>`).join('')}</select></label>
      <div class="row">
        <label class="field"><span>From — type it (e.g. "July 14") or use the calendar</span>${dateField('tStart', t.start_date)}</label>
        <label class="field"><span>To (same day is fine)</span>${dateField('tEnd', t.end_date)}</label>
        <label class="field"><span>Status</span><select id="tStatus"><option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending approval</option><option value="approved" ${t.status === 'approved' ? 'selected' : ''}>Approved</option></select></label>
      </div>
      <label class="field"><span>Projects affected — auto-selected from the Projects section when you pick a member (you can still adjust)</span>
        <div id="tpSelect"></div></label>
      <label class="field"><span>Note (optional)</span><input type="text" id="tNote" value="${esc(t.note)}"></label>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save entry</button></div>
    `, body => {
      bindDateFields(body);
      const tpMs = multiSelect($('#tpSelect', body), {
        options: [...S.projects].filter(p => !p.archived).sort(byName).map(p => ({ id: p.id, label: p.name, sub: p.jira_name || '' })),
        selected: t.project_ids || [],
        placeholder: 'Type a project name to add…',
      });
      // When a member is chosen, select the projects they belong to (from the Projects section rosters)
      $('#tMember', body).onchange = e => {
        const mid = +e.target.value;
        tpMs.set(S.projects.filter(p => !p.archived && (p.member_ids || []).includes(mid)).map(p => p.id));
      };
      $('#mCancel', body).onclick = closeModal;
      busyClick($('#mSave', body), async () => {
        try {
          const payload = {
            member_id: +$('#tMember', body).value,
            start_date: dateVal($('.tStart', body)),
            end_date: dateVal($('.tEnd', body)) || dateVal($('.tStart', body)),
            status: $('#tStatus', body).value,
            project_ids: tpMs.get(),
            note: $('#tNote', body).value.trim(),
          };
          await (t.id ? api('/timeoffs/' + t.id, 'PUT', payload) : api('/timeoffs', 'POST', payload));
          closeModal(); await reload('Time-off saved');
        } catch (e) { toast(e.message, true); }
      });
    });
  };
  $('#toSort').onchange = e => { S._toSort = e.target.value; renderTimeoff(main); };
  $('#toGroup').onchange = e => { S._toGroup = e.target.value; renderTimeoff(main); };
  $('#addTo').onclick = () => form();
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(S.timeoffs.find(t => t.id === +b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/timeoffs/' + b.dataset.del, 'DELETE'); await reload('Deleted'); });
}

/* ============================ SEND NOTIF ============================ */
async function renderProjectView(main) {
  main.innerHTML = `<div class="section-head">
      <h1>Send Notif</h1>
      <p>Covers ${fmt(S.win.start)} → ${fmt(S.win.end)}. Only projects with approved time-off or members observing a holiday appear.</p>
      <span class="spacer"></span>
      <button class="btn-ghost" id="pvRefresh" title="Reload latest send timestamps">↻ Refresh</button>
    </div><div id="pvBody"><div class="empty">Loading…</div></div>`;
  $('#pvRefresh').onclick = () => reload('Refreshed');
  const body = $('#pvBody');
  if (!S.projects.length) { body.innerHTML = '<div class="card"><div class="empty">No projects yet — add one in the Projects section.</div></div>'; return; }

  // Refetch when opening the section (auto-sends update timestamps server-side while
  // you're away); the 45s cache only exists so search typing stays fast.
  const fresh = S._pvData && (Date.now() - S._pvData.at < 45000);
  if (!fresh) {
    S.projects = await api('/projects'); // channels carry last_sent_at / last_sent_via
    S._pvData = {
      at: Date.now(),
      reports:  await Promise.all(S.projects.map(p => api(`/projects/${p.id}/report`).catch(() => null))),
      previews: await Promise.all(S.projects.map(p => api(`/projects/${p.id}/preview`).catch(() => null))),
    };
  }
  const { reports, previews } = S._pvData;

  // Flatten to sendable items, each tagged with its workspace.
  // "Needs attention": a channel whose current notice differs from what was last
  // sent to it (i.e. new/changed info the channel hasn't received) — flags late
  // requests that came in since the last send.
  const items = [];
  S.projects.forEach((p, i) => {
    if (p.archived) return; // archived projects don't appear here
    const rep = reports[i], prev = previews[i];
    if (!rep || !prev || (!rep.ooo.length && !rep.holidayGroups.length)) return;
    if (!hit(p.name, (p.channels || []).map(c => c.name).join(' '))) return;
    for (const m of prev.messages) {
      const sentText = (m.channel.last_sent_text || '');
      const currentText = (m.text || '').replaceAll('@here', '<!here>').replaceAll('@channel', '<!channel>');
      const attention = !!m.channel.last_sent_at && sentText !== currentText; // sent before, but info changed since
      items.push({ kind: m.channel.purpose, wsId: m.channel.workspace_id || null, p, m, attention });
    }
    if (prev.emailFallback) {
      const inferred = (p.channels.find(c => c.workspace_id) || {}).workspace_id || null;
      items.push({ kind: 'email', wsId: inferred, p, text: prev.emailFallback });
    }
  });
  if (!items.length) { body.innerHTML = `<div class="card"><div class="empty">${noMatch('Nobody is out and no holidays fall in this period — nothing to send. 🎉')}</div></div>`; return; }

  // Workspace tabs (only workspaces that actually have items)
  const tabs = S.workspaces.filter(w => items.some(it => it.wsId === w.id)).map(w => ({ id: w.id, label: w.name }));
  if (items.some(it => it.wsId === null)) tabs.push({ id: null, label: 'No workspace set' });
  if (!tabs.find(t => t.id === S._pvWs) && S._pvWs !== null) S._pvWs = undefined;
  const selected = S._pvWs !== undefined ? S._pvWs : tabs[0].id;
  S._pvWs = selected;

  const inWs = items.filter(it => it.wsId === selected);
  const attentionCount = inWs.filter(it => it.attention).length;
  const group = (title, kind, hint) => {
    const rows = inWs.filter(it => it.kind === kind).sort((a, b) => (b.attention ? 1 : 0) - (a.attention ? 1 : 0)); // attention first
    const needs = rows.filter(r => r.attention).length;
    return `<details class="pv-group">
      <summary>${title} <span class="muted small">— ${rows.length ? rows.length + ' to send' : hint}${needs ? ` · <span class="attention-pill">⚠️ ${needs} needs attention</span>` : ''}</span></summary>
      <div class="pv-group-body">${rows.map(it => it.kind === 'email' ? emailItem(it) : channelItem(it)).join('') || `<div class="empty">Nothing here for this period.</div>`}</div>
    </details>`;
  };

  body.innerHTML = `
    ${attentionCount ? `<div class="attention-banner">⚠️ <strong>${attentionCount} channel(s)</strong> have new or changed time-off info since their last notice — they're marked below and sorted to the top.</div>` : ''}
    <div class="ws-tabs">${tabs.map(t => `<button class="ws-tab ${t.id === selected ? 'active' : ''}" data-ws="${t.id === null ? 'null' : t.id}">${esc(t.label)}</button>`).join('')}</div>
    ${group('Internal', 'internal', 'nothing to send')}
    ${group('External', 'external', 'nothing to send')}
    ${group('Emails', 'email', 'no email-only projects')}`;

  body.querySelectorAll('.ws-tab').forEach(t => t.onclick = () => { S._pvWs = t.dataset.ws === 'null' ? null : +t.dataset.ws; renderProjectView(main); });

  body.querySelectorAll('.ch-send').forEach(btn => btn.onclick = async e => {
    e.preventDefault(); e.stopPropagation(); // don't toggle the row open/closed
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api(`/projects/${btn.dataset.pid}/send`, 'POST', { channel_id: +btn.dataset.chid });
      const fail = (r.results || []).find(x => !x.ok);
      if (r.error || fail) {
        toast('Send failed — ' + (r.error || fail.error), true);
        btn.disabled = false; btn.textContent = 'Send';
      } else {
        btn.textContent = 'Sent ✓'; btn.classList.add('btn-sent');
        const ls = btn.closest('summary').querySelector('.last-sent');
        if (ls) ls.textContent = 'Last sent (manual): ' + fmtDT(new Date().toISOString());
        toast('Posted to Slack ✓');
      }
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Send'; }
  });
  body.querySelectorAll('.email-copy').forEach(btn => btn.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const text = btn.closest('details').querySelector('.slack-text').textContent;
    navigator.clipboard.writeText(text).then(
      () => { btn.textContent = 'Copied ✓'; toast('Email text copied — paste it into your email'); },
      () => toast('Copy failed — select the text manually', true));
  });
  body.querySelectorAll('.email-copy-to').forEach(btn => btn.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const text = btn.closest('.em-row').querySelector('.recipients').textContent.trim();
    navigator.clipboard.writeText(text).then(
      () => { btn.textContent = 'Copied ✓'; toast('Recipients copied — paste into the To field'); },
      () => toast('Copy failed — select the addresses manually', true));
  });
}

// Collapsed row: project · #channel · last sent · Send. Click anywhere else to open the preview.
function channelItem(it) {
  const ch = it.m.channel;
  return `<details class="pv-item${it.attention ? ' needs-attention' : ''}">
    <summary>
      <strong>${esc(it.p.name)}</strong>
      <span class="hash">#${esc(ch.name)}</span>
      ${it.attention ? '<span class="attention-pill">⚠️ new info</span>' : ''}
      <span class="spacer"></span>
      <span class="muted small last-sent">${ch.last_sent_at ? (ch.last_sent_via === 'auto' ? '🤖 Sent automatically: ' : 'Last sent (manual): ') + fmtDT(ch.last_sent_at) : 'Never sent yet'}</span>
      <button class="btn-primary ch-send" data-pid="${it.p.id}" data-chid="${ch.id}">Send</button>
    </summary>
    <div class="pv-item-body">
      <div class="slack-msg"><div class="slack-msg-body"><div class="slack-avatar">OD</div>
        <div class="slack-text"><span class="bot-name">Off Duty</span><span class="bot-tag">APP</span>\n${esc(it.m.text)}</div></div></div>
    </div>
  </details>`;
}

function emailItem(it) {
  // Pull just the address-looking parts out of the contacts (they're sometimes
  // written as "jane@acme.com - EC" or several addresses in one line).
  const raw = (it.p.contacts || []).join(', ');
  const emails = [...new Set(raw.match(/[^\s,;<>()"]+@[^\s,;<>()"]+\.[a-z]{2,}/gi) || [])];
  const mgr = (it.p.manager || '').trim();
  return `<details class="pv-item">
    <summary>
      <strong>${esc(it.p.name)}</strong>
      <span class="chip email">Email</span>
      <span class="spacer"></span>
      <button class="btn-ghost email-copy">Copy text</button>
    </summary>
    <div class="pv-item-body">
      <div class="email-meta">
        <div class="em-row">
          <span class="em-label">To (contacts)</span>
          <span class="em-value recipients">${emails.length ? esc(emails.join(', ')) : '<span class="muted">No contacts added yet — add them in Projects</span>'}</span>
          ${emails.length ? '<button class="btn-ghost email-copy-to">Copy recipients</button>' : ''}
        </div>
        ${mgr ? `<div class="em-row"><span class="em-label">Project manager</span><span class="em-value">${esc(mgr)}</span></div>` : ''}
        ${raw && emails.length && raw !== emails.join(', ') ? `<div class="em-row"><span class="em-label">As written</span><span class="em-value muted small">${esc(raw)}</span></div>` : ''}
      </div>
      <div class="slack-msg"><div class="slack-msg-body"><div class="slack-text">${esc(it.text)}</div></div></div>
    </div>
  </details>`;
}

/* ============================ SETTINGS ============================ */
function renderSettings(main) {
  main.innerHTML = `
    <div class="section-head"><h1>Settings</h1><p>Slack workspaces, Jira, notification templates, and the scheduler timezone.</p></div>

    <div class="card"><h2>Archived projects</h2>
      ${(() => {
        const arc = [...S.projects].filter(p => p.archived).sort(byName);
        if (!arc.length) return '<div class="empty">No archived projects. Use <strong>Archive</strong> on a project to park it here.</div>';
        return `<p class="muted small">These are hidden from Projects, Send Notif and the time-off picker, and never send automatically. Restore brings a project back exactly as it was.</p>
        <table><thead><tr><th>Project</th><th>Channels</th><th>Archived</th><th></th></tr></thead><tbody>
        ${arc.map(p => `<tr>
          <td><strong>${esc(p.name)}</strong></td>
          <td class="small">${(p.channels || []).length ? p.channels.map(c => `#${esc(c.name)}`).join(', ') : '<span class="muted">none</span>'}</td>
          <td class="small">${p.archived_at ? esc(fmtDT(p.archived_at)) : '—'}</td>
          <td class="nowrap"><button class="btn-link" data-restore="${p.id}">Restore</button><button class="btn-danger" data-arcdel="${p.id}">Delete</button></td>
        </tr>`).join('')}
        </tbody></table>`;
      })()}
    </div>

    <div class="card"><h2>Jira connection</h2>
      <div id="jiraStatus" class="muted small">Checking…</div>
      <p class="muted small" style="margin-top:8px">Connects to your onboarding project so <strong>Sync from Jira</strong> (in the Projects section) can import new tickets as projects. Set up on the server with <span class="mono">JIRA_BASE_URL</span>, <span class="mono">JIRA_EMAIL</span>, and <span class="mono">JIRA_TOKEN</span> (get a token at id.atlassian.com → Security → API tokens).</p>
    </div>

    <div class="card"><h2>Slack workspaces</h2>
      <p class="muted small">Each Slack org (e.g. nClouds, AppEvolve) needs its own bot token. Create a Slack app in that workspace with the <span class="mono">chat:write</span> + <span class="mono">channels:read</span> scopes, install it, invite the bot to your channels with <span class="mono">/invite</span>, then paste its <span class="mono">xoxb-…</span> token here.</p>
      ${S.workspaces.length ? `<table><thead><tr><th>Workspace</th><th>Bot token</th><th></th></tr></thead><tbody>
        ${S.workspaces.map(w => `<tr><td><strong>${esc(w.name)}</strong></td>
          <td class="mono">${w.has_token ? 'xoxb-••••' + esc(w.token_hint.slice(1)) : '<span class="muted">not set</span>'}</td>
          <td><button class="btn-link" data-wedit="${w.id}">Edit</button><button class="btn-danger" data-wdel="${w.id}">Delete</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">No workspaces yet — add nClouds and AppEvolve here.</div>'}
      <div style="margin-top:10px"><button class="btn-primary" id="addWs">Add workspace</button></div>
    </div>

    <div class="card"><h2>Notification templates</h2>
      <p class="muted small">Placeholders: <span class="mono">{month}</span> <span class="mono">{project}</span> <span class="mono">{ooo_list}</span> <span class="mono">{holiday_list}</span> <span class="mono">{holiday_dates}</span>. Slack formatting works (<span class="mono">*bold*</span>, <span class="mono">:wave:</span>, <span class="mono">@here</span>).</p>
      <label class="field"><span>External template (client-facing channels + email fallback)</span><textarea id="extTpl">${esc(S.settings.external_template)}</textarea></label>
      <label class="field"><span>Internal template (internal channels)</span><textarea id="intTpl">${esc(S.settings.internal_template)}</textarea></label>
      <div class="row">
        <label class="field"><span>Scheduler timezone (IANA name)</span><input type="text" id="tzInput" value="${esc(S.settings.timezone)}"></label>
      </div>
      <button class="btn-primary" id="saveSettings">Save settings</button>
    </div>`;
  const wsForm = w => openModal(`
    <h2>${w.id ? 'Edit workspace' : 'Add workspace'}</h2>
    <label class="field"><span>Workspace name (e.g. nClouds, AppEvolve)</span><input type="text" id="wName" value="${esc(w.name || '')}"></label>
    <label class="field"><span>Bot token (xoxb-…) ${w.id ? '— leave blank to keep the current one' : ''}</span><input type="password" id="wToken" placeholder="xoxb-…"></label>
    <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save workspace</button></div>
  `, body => {
    $('#mCancel', body).onclick = closeModal;
    busyClick($('#mSave', body), async () => {
      try {
        const payload = { name: $('#wName', body).value.trim(), bot_token: $('#wToken', body).value.trim() };
        await (w.id ? api('/workspaces/' + w.id, 'PUT', payload) : api('/workspaces', 'POST', payload));
        closeModal(); await reload('Workspace saved');
      } catch (e) { toast(e.message, true); }
    });
  });
  main.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
    await api('/projects/' + b.dataset.restore + '/restore', 'POST');
    await reload('Restored — it\u2019s back in Projects');
  });
  main.querySelectorAll('[data-arcdel]').forEach(b => b.onclick = async () => {
    const p = S.projects.find(x => x.id === +b.dataset.arcdel);
    if (!confirm(`Permanently delete "${p.name}"?\n\nThis cannot be undone. Its channels and time-off links are removed.`)) return;
    await api('/projects/' + b.dataset.arcdel, 'DELETE');
    await reload('Deleted permanently');
  });
  api('/jira/status').then(s => {
    const el = $('#jiraStatus');
    if (el) el.innerHTML = s.configured
      ? '<span class="badge approved">✓ Connected</span> Jira is set up — the Sync button in Projects is ready to use.'
      : '<span class="badge pending">Not connected</span> Add the Jira environment variables on the server to enable syncing.';
  }).catch(() => { const el = $('#jiraStatus'); if (el) el.textContent = 'Could not check Jira status.'; });
  $('#addWs').onclick = () => wsForm({});
  main.querySelectorAll('[data-wedit]').forEach(b => b.onclick = () => wsForm(S.workspaces.find(w => w.id === +b.dataset.wedit)));
  main.querySelectorAll('[data-wdel]').forEach(b => b.onclick = async () => { await api('/workspaces/' + b.dataset.wdel, 'DELETE'); await reload('Deleted'); });
  busyClick($('#saveSettings'), async () => {
    try {
      await api('/settings', 'PUT', { external_template: $('#extTpl').value, internal_template: $('#intTpl').value, timezone: $('#tzInput').value.trim() });
      await reload('Settings saved');
    } catch (e) { toast(e.message, true); }
  });
}

/* ============================ router ============================ */

/* ============================ WHO'S OUT (CALENDAR) ============================ */
const HOLIDAY_STATUS = { 'PH Employee': 'PH', 'US Employee': 'US' }; // contractors observe none
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// Colour per member so the same person reads the same everywhere on the grid
const CAL_COLORS = ['#2f7d95', '#b4632a', '#5c6bc0', '#2e8b6a', '#a1467e', '#7a6b2f', '#c05555', '#3f7a3f'];
const memberColor = id => CAL_COLORS[Math.abs(Number(id) || 0) % CAL_COLORS.length];

const isoOf = dt => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
// "today" in the app's configured timezone, not the browser's
function todayIso() {
  const tz = (S.settings && S.settings.timezone) || 'Asia/Manila';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // en-CA gives YYYY-MM-DD
}

// Everyone out on a given date: approved time-off + holidays their status observes
function outOn(iso) {
  const q = Q();
  const people = [];
  for (const t of S.timeoffs) {
    if (t.status !== 'approved') continue;
    if (iso < t.start_date || iso > t.end_date) continue;
    const name = memberName(t.member_id);
    const projects = (t.project_ids || []).map(projectName);
    if (q && !(name.toLowerCase().includes(q) || projects.join(' ').toLowerCase().includes(q))) continue;
    people.push({ kind: 'off', id: t.member_id, name, projects, note: t.note || '' });
  }
  const hols = [];
  for (const h of S.holidays) {
    if (h.date !== iso) continue;
    const observers = S.members.filter(m => HOLIDAY_STATUS[m.status] === h.location);
    const shown = q ? observers.filter(m => m.name.toLowerCase().includes(q)) : observers;
    if (!shown.length) continue;
    hols.push({ name: h.name, location: h.location, members: shown });
  }
  return { people, hols };
}

function renderCalendar(main) {
  const view = S._calView || 'month';
  const anchor = S._calAnchor || todayIso();          // any date inside the shown range
  const today = todayIso();
  const a = parseIso(anchor);

  // Work out the visible range + heading for each view
  let start, end, heading;
  if (view === 'month') {
    start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1));
    end = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0));
    heading = `${cap(MONTH_NAMES[a.getUTCMonth()])} ${a.getUTCFullYear()}`;
  } else if (view === 'week') {
    start = addDays(a, -a.getUTCDay());               // back to Sunday
    end = addDays(start, 6);
    heading = `${fmt(isoOf(start))} — ${fmt(isoOf(end))}`;
  } else {
    start = end = a;
    heading = isoOf(a) === today ? `Today · ${fmt(isoOf(a))}` : fmt(isoOf(a));
  }

  const step = view === 'month' ? 'month' : view === 'week' ? 7 : 1;
  const shift = dir => {
    const d = parseIso(S._calAnchor || todayIso());
    if (step === 'month') S._calAnchor = isoOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1)));
    else S._calAnchor = isoOf(addDays(d, dir * step));
    renderCalendar(main);
  };

  main.innerHTML = `
    <div class="section-head">
      <h1>Who's Out</h1><p>Approved time-off and observed holidays, plotted on a calendar.</p>
      <span class="spacer"></span>
      <div class="cal-views">
        ${['month', 'week', 'today'].map(v => `<button class="cal-view ${view === v ? 'active' : ''}" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="card">
      <div class="cal-bar">
        <button class="btn-ghost cal-nav" data-dir="-1" title="Previous">‹</button>
        <button class="btn-ghost" id="calToday">Today</button>
        <button class="btn-ghost cal-nav" data-dir="1" title="Next">›</button>
        <h2 class="cal-heading">${esc(heading)}</h2>
        <span class="spacer"></span>
        <span class="cal-legend"><span class="dot off"></span> time-off <span class="dot hol"></span> holiday</span>
      </div>
      <div id="calBody"></div>
    </div>`;

  const body = $('#calBody');
  if (view === 'today') body.innerHTML = dayPanel(isoOf(a), today);
  else if (view === 'week') body.innerHTML = weekGrid(start, today);
  else body.innerHTML = monthGrid(start, end, today);

  main.querySelectorAll('.cal-view').forEach(b => b.onclick = () => { S._calView = b.dataset.view; renderCalendar(main); });
  main.querySelectorAll('.cal-nav').forEach(b => b.onclick = () => shift(+b.dataset.dir));
  $('#calToday').onclick = () => { S._calAnchor = todayIso(); renderCalendar(main); };
  // clicking a day in month/week view opens that day
  main.querySelectorAll('[data-day]').forEach(c => c.onclick = () => {
    S._calAnchor = c.dataset.day; S._calView = 'today'; renderCalendar(main);
  });
}

// chips shown inside a month/week cell
function cellChips(iso, compact) {
  const { people, hols } = outOn(iso);
  if (!people.length && !hols.length) return '';
  const max = compact ? 3 : 6;
  const chips = people.slice(0, max).map(p =>
    `<span class="cal-chip" style="--c:${memberColor(p.id)}" title="${esc(p.name)}${p.projects.length ? ' — ' + esc(p.projects.join(', ')) : ''}">${esc(p.name)}</span>`).join('');
  const more = people.length > max ? `<span class="cal-more">+${people.length - max} more</span>` : '';
  const hol = hols.map(h => `<span class="cal-chip hol" title="${esc(h.members.map(m => m.name).join(', '))}">${esc(h.name)} (${esc(h.location)})</span>`).join('');
  return hol + chips + more;
}

function monthGrid(start, end, today) {
  const lead = start.getUTCDay();                 // blanks before the 1st
  const days = end.getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = isoOf(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), d)));
    const { people, hols } = outOn(iso);
    const n = people.length;
    cells.push(`<div class="cal-cell${iso === today ? ' today' : ''}${n || hols.length ? ' has' : ''}" data-day="${iso}">
      <div class="cal-daynum">${d}${n ? `<span class="cal-count">${n}</span>` : ''}</div>
      <div class="cal-chips">${cellChips(iso, true)}</div>
    </div>`);
  }
  while (cells.length % 7) cells.push('<div class="cal-cell empty"></div>');
  return `<div class="cal-grid">
    ${DAYS.map(d => `<div class="cal-dow">${d.slice(0, 3)}</div>`).join('')}
    ${cells.join('')}
  </div>`;
}

function weekGrid(start, today) {
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const dt = addDays(start, i);
    const iso = isoOf(dt);
    const { people, hols } = outOn(iso);
    cells.push(`<div class="cal-cell tall${iso === today ? ' today' : ''}${people.length || hols.length ? ' has' : ''}" data-day="${iso}">
      <div class="cal-daynum">${DAYS[dt.getUTCDay()].slice(0, 3)} ${dt.getUTCDate()}${people.length ? `<span class="cal-count">${people.length}</span>` : ''}</div>
      <div class="cal-chips">${cellChips(iso, false) || '<span class="muted small">—</span>'}</div>
    </div>`);
  }
  return `<div class="cal-grid week">${cells.join('')}</div>`;
}

function dayPanel(iso, today) {
  const { people, hols } = outOn(iso);
  if (!people.length && !hols.length) {
    return `<div class="empty">${Q() ? `No matches for "${esc(S._q.trim())}" on this day.` : `Everyone is in on ${fmt(iso)}. 🎉`}</div>`;
  }
  const holBlock = hols.map(h => `<div class="day-row hol">
      <div class="day-name">${esc(h.name)} <span class="chip">${esc(h.location)} holiday</span></div>
      <div class="day-sub">${esc(h.members.map(m => m.name).join(', '))}</div>
    </div>`).join('');
  const offBlock = people.map(p => `<div class="day-row">
      <span class="day-swatch" style="background:${memberColor(p.id)}"></span>
      <div>
        <div class="day-name">${esc(p.name)}</div>
        <div class="day-sub">${p.projects.length ? p.projects.map(x => `<span class="chip">${esc(x)}</span>`).join(' ') : '<span class="muted">no project assigned</span>'}${p.note ? ` · ${esc(p.note)}` : ''}</div>
      </div>
    </div>`).join('');
  return `<div class="day-panel">
    <p class="muted small">${people.length} out${hols.length ? ` · ${hols.length} holiday` : ''}${iso === today ? ' · today' : ''}</p>
    ${holBlock}${offBlock}
  </div>`;
}

const SECTIONS = { projects: renderProjects, members: renderMembers, holidays: renderHolidays, timeoff: renderTimeoff, calendar: renderCalendar, projectview: renderProjectView, settings: renderSettings };
let current = 'projectview';
async function show(section, fresh = false) {
  current = section;
  if (fresh && section === 'projectview') await refresh(); // pick up any automatic sends
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.sec === section));
  if (window.innerWidth <= 720) $('#sidebar').classList.add('collapsed'); // auto-close overlay on phones
  await SECTIONS[section]($('#main'));
}
async function reload(msg) { await refresh(); await show(current); if (msg) toast(msg); }
document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => show(b.dataset.sec, true));

// live search: filters whichever section is open
let _qTimer;
$('#globalSearch').oninput = e => {
  S._q = e.target.value;
  clearTimeout(_qTimer);
  _qTimer = setTimeout(() => show(current), 250);
};

// collapsible sidebar (state remembered)
const sidebar = $('#sidebar');
if (localStorage.getItem('offduty-sidebar') === 'collapsed') sidebar.classList.add('collapsed');
$('#navToggle').onclick = () => {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('offduty-sidebar', sidebar.classList.contains('collapsed') ? 'collapsed' : 'open');
};

(async () => { await refresh(); await show(location.hash.replace('#', '') in SECTIONS ? location.hash.replace('#', '') : 'projectview'); })();
