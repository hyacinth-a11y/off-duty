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
  const plist = [...S.projects].sort(byName).filter(p =>
    hit(p.name, p.jira_name, p.manager, (p.contacts || []).join(' '), (p.channels || []).map(c => c.name).join(' ')) || memberMatch(p));
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
        <td class="small nowrap">${p.auto_enabled && (p.auto_days || []).length ? esc(p.auto_days.map(d => DAYS[d].slice(0, 3)).join(', ')) + '<br>' + esc(p.auto_time || '09:00') : '—'}</td>
        <td class="small contacts-cell" title="${esc(p.contacts.join(', '))}">${p.contacts.length ? esc(p.contacts.slice(0, 2).join(', ')) + (p.contacts.length > 2 ? ` <span class="chip">+${p.contacts.length - 2}</span>` : '') : '—'}</td>
        <td class="nowrap"><button class="btn-link" data-edit="${p.id}">Edit</button><button class="btn-danger" data-del="${p.id}">Delete</button></td>
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
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => projectForm(S.projects.find(p => p.id === +b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this project? Its schedules and time-off links will be removed too.')) return;
    await api('/projects/' + b.dataset.del, 'DELETE'); await reload('Deleted');
  });
}

function projectForm(p) {
  p = p || { name: '', jira_name: '', manager: '', notify_via_email: false, contacts: [], channels: [], member_ids: [] };
  const wsOpts = sel => `<option value="">— pick workspace —</option>` + S.workspaces.map(w => `<option value="${w.id}" ${w.id === sel ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  const contactRow = v => `<input type="text" class="contact" value="${esc(v)}" placeholder="Contact name" style="margin-bottom:6px">`;
  const channelRow = c => `<div class="channel-row" style="margin-bottom:12px;border:1px dashed var(--line);border-radius:8px;padding:8px">
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
    <label class="field"><span>Automatic sending — on the chosen days at the chosen time (Philippine time), this project's notice goes to ALL its channels automatically. It skips silently when nobody is out and no holidays apply. You can always still press Send manually.</span>
      <label style="display:flex;gap:8px;align-items:center;font-weight:600;color:var(--ink);margin:6px 0"><input type="checkbox" id="pAutoEnabled" ${p.auto_enabled ? 'checked' : ''} style="width:auto"> Enable schedule for this project</label>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:4px 0 10px">
        ${DAYS.map((d, i) => `<label style="display:flex;gap:5px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" class="pAutoDay" value="${i}" ${(p.auto_days || []).includes(i) ? 'checked' : ''} style="width:auto">${d}</label>`).join('')}
      </div>
      <div class="row"><label class="field" style="margin:0"><span>At this time</span><input type="time" id="pAutoTime" value="${esc(p.auto_time || '09:00')}"></label></div>
      <label style="display:flex;gap:8px;align-items:center;font-weight:400;color:var(--ink);margin:8px 0 0"><input type="checkbox" id="pAntispam" ${p.antispam !== false ? 'checked' : ''} style="width:auto"> Skip automatic sends when the notice hasn't changed since last time (anti-spam)</label>
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
    $('#mCancel', body).onclick = closeModal;
    busyClick($('#mSave', body), async () => {
      const payload = {
        name: $('#pName', body).value.trim(),
        jira_name: $('#pJira', body).value.trim(),
        manager: $('#pManager', body).value.trim(),
        auto_enabled: $('#pAutoEnabled', body).checked,
        auto_days: [...body.querySelectorAll('.pAutoDay:checked')].map(i => +i.value),
        auto_time: $('#pAutoTime', body).value || '09:00',
        antispam: $('#pAntispam', body).checked,
        notify_via_email: $('#pEmail', body).checked,
        contacts: [...body.querySelectorAll('.contact')].map(i => i.value.trim()).filter(Boolean),
        channels: [...body.querySelectorAll('.channel-row')].map(r => ({
          name: $('.ch-name', r).value.trim().replace(/^#/, ''),
          workspace_id: +$('.ch-ws', r).value || null,
          purpose: $('.ch-purpose', r).value,
          webhook_url: $('.ch-webhook', r).value.trim(),
        })).filter(c => c.name || c.webhook_url),
        member_ids: pmMs.get(),
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
  const rows = S.timeoffs.filter(t => hit(memberName(t.member_id), t.project_ids.map(projectName).join(' '))).sort(sortMode === 'name'
    ? (a, b) => memberName(a.member_id).localeCompare(memberName(b.member_id), undefined, { sensitivity: 'base' }) || a.start_date.localeCompare(b.start_date)
    : (a, b) => a.start_date.localeCompare(b.start_date) || memberName(a.member_id).localeCompare(memberName(b.member_id)));
  main.innerHTML = `
    <div class="section-head">
      <h1>Time-Off Entries</h1><p>The source of truth for requests. Members come from Team Members; projects come from Projects.</p>
      <span class="spacer"></span>
      <label class="small muted" style="display:flex;align-items:center;gap:6px">Sort by
        <select id="toSort" style="width:auto">
          <option value="date" ${sortMode === 'date' ? 'selected' : ''}>Time-off date (earliest first)</option>
          <option value="name" ${sortMode === 'name' ? 'selected' : ''}>Member name (A–Z)</option>
        </select></label>
      <button class="btn-primary" id="addTo">Add time-off entry</button>
    </div>
    <div class="card">
      ${rows.length ? `<table><thead><tr><th>Member</th><th>Dates</th><th>Projects</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>
      ${rows.map(t => `<tr>
        <td><strong>${esc(memberName(t.member_id))}</strong></td>
        <td>${fmtRange(t.start_date, t.end_date)}</td>
        <td>${t.project_ids.map(id => `<span class="chip">${esc(projectName(id))}</span>`).join(' ') || '<span class="muted small">—</span>'}</td>
        <td><span class="badge ${t.status}">${t.status === 'approved' ? 'Approved' : 'Pending approval'}</span></td>
        <td class="small muted">${esc(t.note) || ''}</td>
        <td><button class="btn-link" data-edit="${t.id}">Edit</button><button class="btn-danger" data-del="${t.id}">Delete</button></td>
      </tr>`).join('')}</tbody></table>` : `<div class="empty">${noMatch('No time-off entries yet. Only <strong>approved</strong> entries appear in Slack notices.')}</div>`}
    </div>
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
        options: [...S.projects].sort(byName).map(p => ({ id: p.id, label: p.name, sub: p.jira_name || '' })),
        selected: t.project_ids || [],
        placeholder: 'Type a project name to add…',
      });
      // When a member is chosen, select the projects they belong to (from the Projects section rosters)
      $('#tMember', body).onchange = e => {
        const mid = +e.target.value;
        tpMs.set(S.projects.filter(p => (p.member_ids || []).includes(mid)).map(p => p.id));
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
  return `<details class="pv-item">
    <summary>
      <strong>${esc(it.p.name)}</strong>
      <span class="chip email">Email</span>
      <span class="spacer"></span>
      <button class="btn-ghost email-copy">Copy text</button>
    </summary>
    <div class="pv-item-body">
      <div class="slack-msg"><div class="slack-msg-body"><div class="slack-text">${esc(it.text)}</div></div></div>
    </div>
  </details>`;
}

/* ============================ SETTINGS ============================ */
function renderSettings(main) {
  main.innerHTML = `
    <div class="section-head"><h1>Settings</h1><p>Slack workspaces, Jira, notification templates, and the scheduler timezone.</p></div>

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
const SECTIONS = { projects: renderProjects, members: renderMembers, holidays: renderHolidays, timeoff: renderTimeoff, projectview: renderProjectView, settings: renderSettings };
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
