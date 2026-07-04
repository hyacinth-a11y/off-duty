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
      e.preventDefault();
      sel.push(+el.dataset.id); input.value = ''; renderChips(); renderList(); input.focus();
      list.hidden = false;
    });
  };
  input.oninput = renderList;
  input.onfocus = () => { list.hidden = false; renderList(); };
  document.addEventListener('click', e => { if (mount.isConnected && !mount.contains(e.target)) list.hidden = true; });
  renderChips();
  return { get: () => [...sel], set: ids => { sel = [...ids]; renderChips(); renderList(); } };
}

// ---------------- night mode ----------------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('#themeToggle'); if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
}
let theme = localStorage.getItem('offduty-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(theme);
$('#themeToggle').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('offduty-theme', theme); applyTheme(theme); };

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
  $('#windowChip').textContent = `Notice window: ${S.win.start} → ${S.win.end}${S.win.extended ? ' (extended)' : ''}`;
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
const fmt = d => { const [y, m, dd] = d.split('-'); return new Date(Date.UTC(+y, +m - 1, +dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
const fmtRange = (a, b) => a === b ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;

/* ============================ PROJECTS ============================ */
function renderProjects(main) {
  main.innerHTML = `
    <div class="section-head">
      <h1>Projects</h1><p>Source of truth for every project, its contacts, and its Slack channels.</p>
      <span class="spacer"></span>
      <button class="btn-primary" id="addProject">Add project</button>
    </div>
    <div class="card">
      ${S.projects.length ? `<table><thead><tr>
        <th>Project</th><th>Jira</th><th>Workspace</th><th>Type</th><th>Slack channels</th><th>Contacts</th><th></th>
      </tr></thead><tbody>
      ${S.projects.map(p => `<tr>
        <td><strong>${esc(p.name)}</strong></td>
        <td class="mono">${esc(p.jira_name) || '—'}</td>
        <td>${esc(wsName(p.workspace_id))}</td>
        <td><span class="chip ${p.type}">${p.type}</span></td>
        <td>${p.channels.length ? p.channels.map(c => `<span class="chip ${c.purpose}">#${esc(c.name)} · ${c.purpose}</span>`).join(' ') : ''}
            ${p.notify_via_email && !p.channels.some(c => c.purpose === 'external') ? '<span class="chip email">Email (manual client notice)</span>' : ''}
            ${!p.channels.length && !p.notify_via_email ? '<span class="muted small">none</span>' : ''}</td>
        <td class="small">${p.contacts.map(esc).join(', ') || '—'}</td>
        <td><button class="btn-link" data-edit="${p.id}">Edit</button><button class="btn-danger" data-del="${p.id}">Delete</button></td>
      </tr>`).join('')}
      </tbody></table>` : `<div class="empty">No projects yet. Add your first project to start building notices.</div>`}
    </div>`;
  $('#addProject').onclick = () => projectForm();
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => projectForm(S.projects.find(p => p.id === +b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this project? Its schedules and time-off links will be removed too.')) return;
    await api('/projects/' + b.dataset.del, 'DELETE'); await reload('Deleted');
  });
}

function projectForm(p) {
  p = p || { name: '', jira_name: '', workspace_id: null, type: 'external', notify_via_email: false, contacts: [], channels: [], member_ids: [] };
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
    <div class="row">
      <label class="field"><span>Org workspace</span><select id="pWs">${wsOpts(p.workspace_id)}</select></label>
      <label class="field"><span>Internal or external?</span>
        <select id="pType"><option value="internal" ${p.type === 'internal' ? 'selected' : ''}>Internal</option><option value="external" ${p.type === 'external' ? 'selected' : ''}>External (client-facing)</option></select></label>
    </div>
    <label class="field"><span>Point of contacts (add as many as you need)</span>
      <div id="contacts">${(p.contacts.length ? p.contacts : ['']).map(contactRow).join('')}</div>
      <button type="button" class="btn-ghost" id="addContact">+ Add contact</button></label>
    <label class="field"><span>Slack channels — easiest: paste a <strong>Webhook URL</strong> per channel (Slack app → Incoming Webhooks → Add New Webhook → pick the channel). With a webhook, no bot invite or workspace token is needed; the name is just a label.</span>
      <div id="channels">${p.channels.map(channelRow).join('')}</div>
      <button type="button" class="btn-ghost" id="addChannel">+ Add channel</button></label>
    <label class="field" style="display:flex;gap:8px;align-items:center">
      <input type="checkbox" id="pEmail" ${p.notify_via_email ? 'checked' : ''} style="width:auto">
      <span style="margin:0">No external Slack channel — mark as <strong>Email</strong> (I'll notify the client manually)</span></label>
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
        workspace_id: +$('#pWs', body).value || null,
        type: $('#pType', body).value,
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
  main.innerHTML = `
    <div class="section-head">
      <h1>Team Members</h1><p>Source of truth for everyone in the company. Add people here before logging their time off.</p>
      <span class="spacer"></span><button class="btn-primary" id="addMember">Add member</button>
    </div>
    <div class="card">
      ${S.members.length ? `<table><thead><tr><th>Name</th><th>Employment status</th><th>Holidays that apply</th><th></th></tr></thead><tbody>
      ${S.members.map(m => `<tr>
        <td><strong>${esc(m.name)}</strong></td><td>${esc(m.status)}</td>
        <td class="small muted">${m.status === 'PH Employee' ? 'PH holidays' : m.status === 'US Employee' ? 'US holidays' : 'None (contractor)'}</td>
        <td><button class="btn-link" data-edit="${m.id}">Edit</button><button class="btn-danger" data-del="${m.id}">Delete</button></td>
      </tr>`).join('')}</tbody></table>` : `<div class="empty">No team members yet.</div>`}
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
  const list = S.holidays.filter(h => h.date.startsWith(year)).sort((a, b) => a.date.localeCompare(b.date));
  const block = loc => {
    const rows = list.filter(h => h.location === loc);
    return `<div class="card"><h2>${loc === 'PH' ? '🇵🇭 Philippine holidays' : '🇺🇸 US holidays'} · ${esc(year)}</h2>
      ${rows.length ? `<table><thead><tr><th>Date</th><th>Holiday</th><th></th></tr></thead><tbody>
      ${rows.map(h => `<tr><td class="mono">${h.date} <span class="muted">(${fmt(h.date)})</span></td><td>${esc(h.name)}</td>
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
      <label class="field"><span>Date</span><input type="date" id="hDate" value="${h.date || year + '-01-01'}"></label>
      <label class="field"><span>Location</span><select id="hLoc"><option value="PH" ${h.location === 'PH' ? 'selected' : ''}>Philippines</option><option value="US" ${h.location === 'US' ? 'selected' : ''}>United States</option></select></label>
    </div>
    <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save holiday</button></div>
  `, body => {
    $('#mCancel', body).onclick = closeModal;
    busyClick($('#mSave', body), async () => {
      try {
        const payload = { name: $('#hName', body).value.trim(), date: $('#hDate', body).value, location: $('#hLoc', body).value };
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
  const rows = [...S.timeoffs].sort((a, b) => b.start_date.localeCompare(a.start_date));
  main.innerHTML = `
    <div class="section-head">
      <h1>Time-Off Entries</h1><p>The source of truth for requests. Members come from Team Members; projects come from Projects.</p>
      <span class="spacer"></span><button class="btn-primary" id="addTo">Add time-off entry</button>
    </div>
    <div class="card">
      ${rows.length ? `<table><thead><tr><th>Member</th><th>Dates</th><th>Projects</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>
      ${rows.map(t => `<tr>
        <td><strong>${esc(memberName(t.member_id))}</strong></td>
        <td class="mono">${t.start_date === t.end_date ? t.start_date : t.start_date + ' → ' + t.end_date}</td>
        <td>${t.project_ids.map(id => `<span class="chip">${esc(projectName(id))}</span>`).join(' ') || '<span class="muted small">—</span>'}</td>
        <td><span class="badge ${t.status}">${t.status === 'approved' ? 'Approved' : 'Pending approval'}</span></td>
        <td class="small muted">${esc(t.note) || ''}</td>
        <td><button class="btn-link" data-edit="${t.id}">Edit</button><button class="btn-danger" data-del="${t.id}">Delete</button></td>
      </tr>`).join('')}</tbody></table>` : `<div class="empty">No time-off entries yet. Only <strong>approved</strong> entries appear in Slack notices.</div>`}
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
        <label class="field"><span>From</span><input type="date" id="tStart" value="${t.start_date}"></label>
        <label class="field"><span>To (same day is fine)</span><input type="date" id="tEnd" value="${t.end_date}"></label>
        <label class="field"><span>Status</span><select id="tStatus"><option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending approval</option><option value="approved" ${t.status === 'approved' ? 'selected' : ''}>Approved</option></select></label>
      </div>
      <label class="field"><span>Projects affected — auto-selected from the Projects section when you pick a member (you can still adjust)</span>
        <div id="tpSelect"></div></label>
      <label class="field"><span>Note (optional)</span><input type="text" id="tNote" value="${esc(t.note)}"></label>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancel</button><button class="btn-primary" id="mSave">Save entry</button></div>
    `, body => {
      const tpMs = multiSelect($('#tpSelect', body), {
        options: S.projects.map(p => ({ id: p.id, label: p.name, sub: p.jira_name || '' })),
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
            start_date: $('#tStart', body).value,
            end_date: $('#tEnd', body).value || $('#tStart', body).value,
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
  $('#addTo').onclick = () => form();
  main.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(S.timeoffs.find(t => t.id === +b.dataset.edit)));
  main.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/timeoffs/' + b.dataset.del, 'DELETE'); await reload('Deleted'); });
}

/* ============================ PROJECT VIEW ============================ */
async function renderProjectView(main) {
  main.innerHTML = `<div class="section-head">
      <h1>Project View</h1>
      <p>Who's out per project this period, exactly what each Slack channel will receive, and when it goes out automatically.</p>
    </div><div id="pvCards"><div class="empty">Loading…</div></div>`;
  const wrap = $('#pvCards');
  if (!S.projects.length) { wrap.innerHTML = '<div class="card"><div class="empty">No projects yet — add one in the Projects section.</div></div>'; return; }
  const previews = await Promise.all(S.projects.map(p => api(`/projects/${p.id}/preview`).catch(() => null)));
  const reports = await Promise.all(S.projects.map(p => api(`/projects/${p.id}/report`).catch(() => null)));

  wrap.innerHTML = S.projects.map((p, i) => {
    const rep = reports[i], prev = previews[i];
    const scheds = S.schedules.filter(s => s.project_id === p.id);
    const ooo = rep ? rep.ooo : [], hols = rep ? rep.holidayGroups : [];
    return `<div class="card" data-pid="${p.id}">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">${esc(p.name)}</h2>
        <span class="chip ${p.type}">${p.type}</span>
        <span class="muted small mono">${esc(p.jira_name)}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn-ghost pv-send">Send all channels</button>
      </div>
      <div class="pv-grid" style="margin-top:12px">
        <div>
          <strong>Out of office (${rep ? rep.win.start : ''} → ${rep ? rep.win.end : ''})</strong>
          ${ooo.length ? `<ul class="pv-list">${ooo.map(t => `<li>${esc(t.member.name)} — <span class="mono">${fmtRange(t.start_date, t.end_date)}</span></li>`).join('')}</ul>` : '<div class="muted small">Nobody scheduled out 🎉</div>'}
        </div>
        <div>
          <strong><span class="holiday-dot">●</span> Observing holidays</strong>
          ${hols.length ? `<ul class="pv-list">${hols.map(g => `<li><span class="mono">${fmt(g.date)}</span> ${esc(g.name)} (${g.location}): ${g.members.map(m => esc(m.name)).join(', ')}</li>`).join('')}</ul>` : '<div class="muted small">No holidays in this period</div>'}
        </div>
      </div>
      <hr class="divider">
      <strong>Channel previews</strong> <span class="muted small">— press Send on a channel to post just that message, or send all at once.</span>
      ${prev && prev.messages.length ? prev.messages.map(m => slackCard(m.channel, m.workspace, m.text)).join('') : ''}
      ${prev && prev.emailFallback ? `<div class="slack-msg"><div class="slack-msg-head"><span class="chip email">Email — send to the client manually</span><button class="btn-ghost email-copy" style="margin-left:auto;padding:4px 12px;font-size:13px">Copy text</button></div><div class="slack-msg-body"><div class="slack-text">${esc(prev.emailFallback)}</div></div></div>` : ''}
      ${prev && !prev.messages.length && !prev.emailFallback ? '<div class="muted small" style="margin-top:6px">No Slack channels configured for this project yet.</div>' : ''}
      <hr class="divider">
      <strong>Automatic schedule</strong> <span class="muted small">— only fires while the app is awake. On free hosting the app sleeps when idle, so rely on the Send buttons; on always-on (paid) hosting this works fully.</span>
      <div class="scheds">${scheds.map(s => `
        <div class="sched-row" data-sid="${s.id}">
          <span>Every <strong>${DAYS[s.day]}</strong> at <span class="mono">${s.time}</span> (${esc(S.settings.timezone)})</span>
          <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="sch-en" ${s.enabled ? 'checked' : ''}> enabled</label>
          <span class="muted small">${s.last_sent ? 'last sent ' + s.last_sent.replace('T', ' ') : 'never sent yet'}</span>
          <button class="btn-danger sch-del">Remove</button>
        </div>`).join('') || '<div class="muted small">No automatic schedule yet — notices only go out when you press Send.</div>'}
      </div>
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <label class="field" style="margin:0"><span>Day</span><select class="new-day">${DAYS.map((d, i2) => `<option value="${i2}" ${i2 === 1 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="field" style="margin:0"><span>Time</span><input type="time" class="new-time" value="09:00"></label>
        <button class="btn-ghost pv-addsched" style="flex:0">Add schedule</button>
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.card').forEach(card => {
    const pid = +card.dataset.pid;
    const doSend = async (btn, channelId, label) => {
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Sending…';
      try {
        const r = await api(`/projects/${pid}/send`, 'POST', channelId ? { channel_id: channelId } : {});
        if (r.error) toast(r.error, true);
        else {
          const fails = (r.results || []).filter(x => !x.ok);
          if (!(r.results || []).length) toast('Nothing to send — add a Slack channel to this project first', true);
          else if (fails.length) toast('Send failed — ' + fails.map(f => `#${f.channel}: ${f.error}`).join(' · '), true);
          else toast(label + ' ✓');
        }
      } catch (e) { toast(e.message, true); }
      btn.disabled = false; btn.textContent = old;
    };
    $('.pv-send', card).onclick = e => doSend(e.target, null, 'Sent to all channels');
    card.querySelectorAll('.ch-send').forEach(b => b.onclick = () => doSend(b, +b.dataset.chid, 'Sent'));
    const copyBtn = $('.email-copy', card);
    if (copyBtn) copyBtn.onclick = () => {
      const text = copyBtn.closest('.slack-msg').querySelector('.slack-text').textContent;
      navigator.clipboard.writeText(text).then(() => toast('Email text copied — paste it into your email'), () => toast('Copy failed — select the text manually', true));
    };
    busyClick($('.pv-addsched', card), async () => {
      try {
        await api('/schedules', 'POST', { project_id: pid, day: +$('.new-day', card).value, time: $('.new-time', card).value });
        await reload('Schedule added');
      } catch (e) { toast(e.message, true); }
    });
    card.querySelectorAll('.sched-row').forEach(row => {
      const sid = +row.dataset.sid;
      $('.sch-en', row).onchange = async e => { await api('/schedules/' + sid, 'PUT', { enabled: e.target.checked }); toast(e.target.checked ? 'Schedule enabled' : 'Schedule paused'); };
      $('.sch-del', row).onclick = async () => { await api('/schedules/' + sid, 'DELETE'); await reload('Schedule removed'); };
    });
  });
}

function slackCard(channel, workspace, text) {
  return `<div class="slack-msg">
    <div class="slack-msg-head"><span class="hash">#${esc(channel.name)}</span><span class="chip ${channel.purpose}">${channel.purpose}</span><span class="ws">${channel.webhook_url ? 'via webhook ✓' : esc(workspace || 'workspace not set')}</span>
      <button class="btn-primary ch-send" data-chid="${channel.id}" style="padding:4px 12px;font-size:13px">Send</button></div>
    <div class="slack-msg-body"><div class="slack-avatar">OD</div>
      <div class="slack-text"><span class="bot-name">Off Duty</span><span class="bot-tag">APP</span>\n${esc(text)}</div></div>
  </div>`;
}

/* ============================ SETTINGS ============================ */
function renderSettings(main) {
  main.innerHTML = `
    <div class="section-head"><h1>Settings</h1><p>Slack workspaces, notification templates, and the scheduler timezone.</p></div>

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
async function show(section) {
  current = section;
  $('#sectionSelect').value = section;
  await SECTIONS[section]($('#main'));
}
async function reload(msg) { await refresh(); await show(current); if (msg) toast(msg); }
$('#sectionSelect').onchange = e => show(e.target.value);

(async () => { await refresh(); await show(location.hash.replace('#', '') in SECTIONS ? location.hash.replace('#', '') : 'projectview'); })();
