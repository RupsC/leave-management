'use strict';

/* ------------------------------------------------------------------ helpers */
const state = { user: null, csrf: null, leaveTypes: [], nav: [] };

const el = (id) => document.getElementById(id);
const view = () => el('view');

function toast(message, isError) {
  const box = el('toast');
  box.textContent = message;
  box.className = `toast${isError ? ' error' : ''}`;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 4200);
}

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  if (options.form) {
    opts.body = options.form;
  }
  if (opts.method !== 'GET' && state.csrf) opts.headers['X-CSRF-Token'] = state.csrf;

  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || 'Something went wrong.';
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const days = (n) => (Number(n) === 1 ? '1 day' : `${Number(n)} days`);

function loading(message = 'Loading…') {
  view().innerHTML = `<p class="muted">${esc(message)}</p>`;
}

function failure(err) {
  if (err.status === 401) {
    state.user = null;
    renderAuth();
    return;
  }
  view().innerHTML = `<div class="error-box">${esc(err.message)}</div>
    <button class="btn btn-outline" onclick="location.reload()">Try again</button>`;
}

function emptyBox(icon, title, text) {
  return `<div class="empty"><div class="big" aria-hidden="true">${icon}</div>
    <h3>${esc(title)}</h3><p class="muted">${esc(text)}</p></div>`;
}

/* -------------------------------------------------------------------- layout */
const NAV = [
  { href: '#/dashboard', label: 'Dashboard', roles: ['admin', 'manager', 'employee'] },
  { href: '#/apply', label: 'Apply for leave', roles: ['admin', 'manager', 'employee'] },
  { href: '#/requests', label: 'My requests', roles: ['admin', 'manager', 'employee'] },
  { href: '#/approvals', label: 'Approvals', roles: ['admin', 'manager'] },
  { href: '#/calendar', label: 'Team calendar', roles: ['admin', 'manager', 'employee'] },
  { href: '#/notifications', label: 'Notifications', roles: ['admin', 'manager', 'employee'] },
  { href: '#/audit', label: 'Audit log', roles: ['admin'] },
];

function renderChrome() {
  const nav = el('mainnav');
  if (!state.user) {
    nav.innerHTML = '';
    el('who').textContent = '';
    el('signOutBtn').hidden = true;
    el('unreadBadge').hidden = true;
    return;
  }
  nav.innerHTML = NAV.filter((item) => item.roles.includes(state.user.role))
    .map((item) => `<a href="${item.href}" data-route="${item.href}">${item.label}</a>`)
    .join('');
  el('who').textContent = `${state.user.name} · ${state.user.role}`;
  el('signOutBtn').hidden = false;
  setUnread(state.user.unreadCount ?? 0);
  highlightNav();
}

function setUnread(count) {
  const badge = el('unreadBadge');
  badge.textContent = count > 99 ? '99+' : String(count);
  badge.hidden = !count;
}

function highlightNav() {
  const hash = location.hash || '#/dashboard';
  document.querySelectorAll('#mainnav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === hash);
  });
}

async function refreshUnread() {
  if (!state.user) return;
  try {
    const data = await api('/notifications/unread-count');
    setUnread(data.unreadCount);
  } catch { /* ignore */ }
}

/* ---------------------------------------------------------------------- auth */
function renderAuth(mode = 'signin') {
  renderChrome();
  const signingIn = mode === 'signin';
  view().innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Leave Management</h1>
        <p class="muted">Apply for leave, track balances and approve your team's requests.</p>
        <div class="tabs" role="tablist">
          <button type="button" class="${signingIn ? 'active' : ''}" data-mode="signin" role="tab" aria-selected="${signingIn}">Sign in</button>
          <button type="button" class="${!signingIn ? 'active' : ''}" data-mode="signup" role="tab" aria-selected="${!signingIn}">Create account</button>
        </div>
        <div id="authError" class="error-box" hidden></div>
        <form id="authForm" novalidate>
          ${!signingIn ? `
          <div class="field">
            <label for="name">Full name</label>
            <input id="name" name="name" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="department">Department <span class="muted">(optional)</span></label>
            <input id="department" name="department" />
          </div>` : ''}
          <div class="field">
            <label for="email">Work e-mail</label>
            <input id="email" name="email" type="email" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="${signingIn ? 'current-password' : 'new-password'}" required />
            ${!signingIn ? '<div class="hint">At least 8 characters, with a letter and a number.</div>' : ''}
          </div>
          <button class="btn" type="submit">${signingIn ? 'Sign in' : 'Create account'}</button>
        </form>
        <details style="margin-top:16px">
          <summary class="muted">Demo accounts</summary>
          <ul class="demo-list">
            <li>Admin: <code>anita.admin@example.test</code></li>
            <li>Manager: <code>rajesh.manager@example.test</code></li>
            <li>Employee: <code>priya.employee@example.test</code></li>
            <li>Password for all: <code>Password@123</code></li>
          </ul>
        </details>
      </div>
    </div>`;

  view().querySelectorAll('.tabs button').forEach((btn) => {
    btn.onclick = () => renderAuth(btn.dataset.mode);
  });

  el('authForm').onsubmit = async (event) => {
    event.preventDefault();
    const errorBox = el('authError');
    errorBox.hidden = true;
    const payload = {
      email: el('email').value.trim(),
      password: el('password').value,
    };
    if (!signingIn) {
      payload.name = el('name').value.trim();
      payload.department = el('department').value.trim() || undefined;
    }
    try {
      const data = await api(signingIn ? '/auth/signin' : '/auth/signup', {
        method: 'POST',
        body: payload,
      });
      state.user = data.user;
      state.csrf = data.csrfToken;
      location.hash = '#/dashboard';
      router();
      toast(signingIn ? `Welcome back, ${data.user.name.split(' ')[0]}.` : 'Account created.');
    } catch (err) {
      const fields = err.data && err.data.error && err.data.error.details && err.data.error.details.fields;
      errorBox.innerHTML = fields && fields.length
        ? fields.map((f) => esc(f.message)).join('<br>')
        : esc(err.message);
      errorBox.hidden = false;
    }
  };
}

/* ----------------------------------------------------------------- dashboard */
async function renderDashboard() {
  loading('Loading your dashboard…');
  const [dash, types] = await Promise.all([api('/dashboard'), api('/leave-types')]);
  state.leaveTypes = types.leaveTypes;
  const isTeamPerson = state.user.role !== 'employee';

  const balanceCards = dash.balances.map((b) => {
    const pct = b.entitledDays > 0 ? Math.max(0, Math.min(100, (b.remainingDays / b.entitledDays) * 100)) : 0;
    return `<div class="card accent">
      <div class="balance-item">
        <strong><span class="dot" style="background:${esc(b.color)}"></span>${esc(b.leaveType)}</strong>
        <span class="muted">${b.remainingDays} / ${b.entitledDays} left</span>
        <div class="bar"><span style="width:${pct}%;background:${esc(b.color)}"></span></div>
      </div>
      <p class="muted" style="margin:10px 0 0">Used ${b.usedDays} of ${b.entitledDays} day(s) in ${dash.year}</p>
    </div>`;
  }).join('');

  const pendingRows = dash.pending.length
    ? dash.pending.map((r) => `<tr>
        <td>${esc(r.leaveType)}</td>
        <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
        <td>${days(r.workingDays)}${r.halfDay !== 'none' ? ` (half day, ${r.halfDay})` : ''}</td>
        <td><span class="pill pending">pending</span></td>
        <td><button class="btn btn-sm btn-outline" data-cancel="${r.id}">Cancel</button></td>
      </tr>`).join('')
    : '';

  const upcoming = dash.upcoming.length
    ? `<ul class="balance-list" style="list-style:none;padding:0;margin:0">
        ${dash.upcoming.map((r) => `<li><span class="dot" style="background:${esc(r.leaveTypeColor)}"></span>
          <strong>${esc(r.leaveType)}</strong> · ${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · ${days(r.workingDays)}</li>`).join('')}
      </ul>`
    : emptyBox('🗓️', 'No approved leave coming up', 'Approved future leave will be listed here.');

  const teamBlock = isTeamPerson && dash.team
    ? `<section class="card" style="margin-top:16px">
        <div class="page-head" style="margin-bottom:12px">
          <div><h2>Your team</h2><p class="muted">${dash.team.people} people · ${dash.team.pendingCount} waiting for a decision</p></div>
          <a class="btn btn-outline btn-sm" href="#/approvals">Open approvals</a>
        </div>
        ${dash.team.pending.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th></tr></thead>
          <tbody>${dash.team.pending.slice(0, 6).map((r) => `<tr>
            <td>${esc(r.employeeName)}</td><td>${esc(r.leaveType)}</td>
            <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td><td>${days(r.workingDays)}</td>
          </tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Nothing waiting for a decision right now.</p>'}
      </section>`
    : '';

  view().innerHTML = `
    <div class="page-head">
      <div>
        <h1>Hello, ${esc(state.user.name.split(' ')[0])}</h1>
        <p class="muted">Today is ${fmtDate(dash.today)} · leave year ${dash.year}</p>
      </div>
      <a class="btn" href="#/apply">Apply for leave</a>
    </div>
    <div class="grid cols-3">${balanceCards || emptyBox('📊', 'No leave types yet', 'An admin needs to set up leave types.')}</div>
    <div class="grid cols-3" style="margin-top:16px">
      <div class="card amber stat"><span class="num">${dash.totals.pending}</span><span class="label">Pending requests</span></div>
      <div class="card green stat"><span class="num">${dash.totals.approved}</span><span class="label">Approved this year</span></div>
      <div class="card stat"><span class="num">${dash.totals.rejected + dash.totals.cancelled}</span><span class="label">Rejected or cancelled</span></div>
    </div>
    ${pendingRows ? `<section class="card" style="margin-top:16px"><h2>Pending requests</h2>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th></th></tr></thead>
      <tbody>${pendingRows}</tbody></table></div></section>` : ''}
    <section class="card" style="margin-top:16px"><h2>Upcoming approved leave</h2>${upcoming}</section>
    ${teamBlock}
    <section class="card" style="margin-top:16px">
      <div class="page-head" style="margin-bottom:8px"><h2>Your leave history</h2><a class="btn btn-outline btn-sm" href="#/requests">See all</a></div>
      ${historyTable(dash.pending.concat(dash.approved, dash.history).slice(0, 5))}
    </section>`;

  view().querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.onclick = () => cancelRequest(Number(btn.dataset.cancel));
  });
}

function historyTable(rows) {
  if (!rows.length) return emptyBox('📄', 'No leave requests yet', 'Apply for leave and it will show up here.');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Decided by</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><span class="dot" style="background:${esc(r.leaveTypeColor)}"></span>${esc(r.leaveType)}</td>
      <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}</td>
      <td>${days(r.workingDays)}</td>
      <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
      <td>${r.decidedByName ? esc(r.decidedByName) : '<span class="muted">—</span>'}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function cancelRequest(id) {
  if (!confirm('Cancel this leave request? If it was approved the days go back to your balance.')) return;
  try {
    await api(`/leave-requests/${id}/cancel`, { method: 'POST' });
    toast('Request cancelled.');
    router();
    refreshUnread();
  } catch (err) {
    toast(err.message, true);
  }
}

/* --------------------------------------------------------------------- apply */
async function renderApply() {
  loading('Preparing the form…');
  const types = await api('/leave-types');
  state.leaveTypes = types.leaveTypes;
  view().innerHTML = `
    <div class="page-head"><div><h1>Apply for leave</h1>
      <p class="muted">Weekends are not counted. A half day counts as 0.5 day and must be a single day.</p></div></div>
    <section class="card" style="max-width:720px">
      <div id="applyError" class="error-box" hidden></div>
      <div id="overlapNote"></div>
      <form id="applyForm" novalidate>
        <div class="form-row">
          <div class="field">
            <label for="leaveTypeId">Leave type</label>
            <select id="leaveTypeId" name="leaveTypeId" required>
              ${state.leaveTypes.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.defaultDays} days per year)</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="halfDay">Duration</label>
            <select id="halfDay" name="halfDay">
              <option value="none">Full day(s)</option>
              <option value="am">Half day — morning</option>
              <option value="pm">Half day — afternoon</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label for="startDate">Start date</label>
            <input id="startDate" name="startDate" type="date" required />
          </div>
          <div class="field">
            <label for="endDate">End date</label>
            <input id="endDate" name="endDate" type="date" required />
          </div>
        </div>
        <div class="field">
          <label for="reason">Reason</label>
          <textarea id="reason" name="reason" required minlength="10" maxlength="500"
            placeholder="A short explanation for your manager (10–500 characters)"></textarea>
          <div class="hint"><span id="reasonCount">0</span>/500 characters</div>
        </div>
        <div class="field">
          <label for="attachment">Supporting document <span class="muted">(optional, PDF/PNG/JPG, max 5 MB)</span></label>
          <input id="attachment" name="attachment" type="file" accept="application/pdf,image/png,image/jpeg" />
          <div class="hint">Stored privately on the server. Only you, your manager and an admin can open it.</div>
        </div>
        <button class="btn" type="submit" id="applySubmit">Submit request</button>
      </form>
    </section>`;

  const reason = el('reason');
  reason.oninput = () => { el('reasonCount').textContent = String(reason.value.length); };
  el('startDate').onchange = () => {
    if (el('endDate').value && el('endDate').value < el('startDate').value) el('endDate').value = el('startDate').value;
    el('endDate').min = el('startDate').value;
    checkOverlap();
  };
  el('endDate').onchange = checkOverlap;

  async function checkOverlap() {
    const start = el('startDate').value;
    const end = el('endDate').value || start;
    if (!start) return;
    try {
      const data = await api(`/overlaps?startDate=${start}&endDate=${end}`);
      el('overlapNote').innerHTML = data.hasOverlap
        ? `<div class="notice">Heads-up: ${data.conflicts.map((c) => esc(c.userName)).join(', ')} already have leave on these dates.
             You can still apply — your manager decides.</div>`
        : '';
    } catch { /* ignore preview errors */ }
  }

  el('applyForm').onsubmit = async (event) => {
    event.preventDefault();
    const errorBox = el('applyError');
    errorBox.hidden = true;
    const form = new FormData();
    form.append('leaveTypeId', el('leaveTypeId').value);
    form.append('startDate', el('startDate').value);
    form.append('endDate', el('endDate').value || el('startDate').value);
    form.append('halfDay', el('halfDay').value);
    form.append('reason', el('reason').value);
    const file = el('attachment').files[0];
    if (file) form.append('attachment', file);
    const submit = el('applySubmit');
    submit.disabled = true;
    try {
      const data = await api('/leave-requests', { method: 'POST', form });
      toast(`Request submitted for ${days(data.workingDays)}.`);
      location.hash = '#/requests';
      router();
      refreshUnread();
    } catch (err) {
      const fields = err.data && err.data.error && err.data.error.details && err.data.error.details.fields;
      errorBox.innerHTML = fields && fields.length
        ? fields.map((f) => esc(f.message)).join('<br>')
        : esc(err.message);
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: 'center' });
    } finally {
      submit.disabled = false;
    }
  };
}

/* ------------------------------------------------------------------ requests */
async function renderRequests() {
  loading('Loading requests…');
  const status = state.requestStatus || '';
  const data = await api(`/leave-requests?scope=mine${status ? `&status=${status}` : ''}`);
  view().innerHTML = `
    <div class="page-head">
      <div><h1>My leave requests</h1><p class="muted">${data.count} request(s)</p></div>
      <a class="btn" href="#/apply">New request</a>
    </div>
    <div class="card">
      <div class="field" style="max-width:260px">
        <label for="statusFilter">Filter by status</label>
        <select id="statusFilter">
          <option value="">All statuses</option>
          ${['pending', 'approved', 'rejected', 'cancelled'].map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </div>
      ${data.requests.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Reason</th><th>Decision</th><th></th></tr></thead>
        <tbody>${data.requests.map((r) => `<tr>
          <td><span class="dot" style="background:${esc(r.leaveTypeColor)}"></span>${esc(r.leaveType)}</td>
          <td>${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}${r.halfDay !== 'none' ? `<div class="muted">half day (${esc(r.halfDay)})</div>` : ''}</td>
          <td>${days(r.workingDays)}</td>
          <td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td>
          <td class="muted">${esc(r.reason)}</td>
          <td>${r.decidedByName ? `${esc(r.decidedByName)}<div class="muted">${esc(r.decisionComment || '')}</div>` : '<span class="muted">—</span>'}</td>
          <td>${(r.status === 'pending' || r.status === 'approved')
            ? `<button class="btn btn-sm btn-outline" data-cancel="${r.id}">Cancel</button>` : ''}
            ${r.attachmentCount ? `<button class="btn btn-sm btn-outline" data-doc="${r.id}">Document</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyBox('🗂️', 'Nothing here yet', 'Your leave requests will appear in this list.')}
    </div>`;
  el('statusFilter').onchange = (e) => {
    state.requestStatus = e.target.value;
    renderRequests().catch(failure);
  };
  view().querySelectorAll('[data-cancel]').forEach((b) => { b.onclick = () => cancelRequest(Number(b.dataset.cancel)); });
  view().querySelectorAll('[data-doc]').forEach((b) => {
    b.onclick = () => window.open(`/api/leave-requests/${b.dataset.doc}/attachment`, '_blank');
  });
}

/* ----------------------------------------------------------------- approvals */
async function renderApprovals() {
  if (state.user.role === 'employee') {
    view().innerHTML = `<div class="error-box">Approvals are for managers and admins.</div>`;
    return;
  }
  loading('Loading the approval queue…');
  const scope = state.user.role === 'admin' ? 'all' : 'team';
  const data = await api(`/leave-requests?scope=${scope}&status=pending`);
  const queue = data.requests.filter((r) => r.userId !== state.user.id);
  view().innerHTML = `
    <div class="page-head"><div><h1>Approvals</h1>
      <p class="muted">${state.user.role === 'admin' ? 'Every pending request in the company.' : 'Pending requests from your team.'}
      You cannot approve your own leave.</p></div></div>
    <div class="card">
      ${queue.length ? queue.map((r) => `
        <div style="border-bottom:1px solid var(--line);padding:14px 0">
          <div class="page-head" style="margin-bottom:8px">
            <div>
              <h3>${esc(r.employeeName)} · <span class="dot" style="background:${esc(r.leaveTypeColor)}"></span>${esc(r.leaveType)}</h3>
              <p class="muted">${fmtDate(r.startDate)} → ${fmtDate(r.endDate)} · ${days(r.workingDays)}${r.halfDay !== 'none' ? ` (half day, ${esc(r.halfDay)})` : ''}</p>
              <p class="muted">Reason: ${esc(r.reason)}</p>
              ${r.attachmentCount ? `<button class="btn btn-sm btn-outline" data-doc="${r.id}">Open document</button>` : ''}
            </div>
            <span class="pill pending">pending</span>
          </div>
          <div class="field" style="margin-bottom:8px">
            <label for="comment-${r.id}">Comment <span class="muted">(required to reject)</span></label>
            <input id="comment-${r.id}" data-comment="${r.id}" maxlength="500" placeholder="Add a short note" />
          </div>
          <div class="btn-row">
            <button class="btn btn-approve btn-sm" data-approve="${r.id}">Approve</button>
            <button class="btn btn-reject btn-sm" data-reject="${r.id}">Reject</button>
          </div>
        </div>`).join('')
        : emptyBox('✅', 'No requests waiting', 'When your team applies for leave it appears here.')}
    </div>`;

  async function decide(id, action) {
    const comment = (view().querySelector(`[data-comment="${id}"]`) || {}).value || '';
    if (action === 'reject' && !comment.trim()) {
      toast('Please write a reason before rejecting.', true);
      return;
    }
    try {
      await api(`/leave-requests/${id}/decision`, { method: 'POST', body: { action, comment } });
      toast(action === 'approve' ? 'Request approved and balance updated.' : 'Request rejected.');
      renderApprovals();
      refreshUnread();
    } catch (err) {
      toast(err.message, true);
      if (err.status === 409 || err.status === 403) renderApprovals();
    }
  }

  view().querySelectorAll('[data-approve]').forEach((b) => { b.onclick = () => decide(Number(b.dataset.approve), 'approve'); });
  view().querySelectorAll('[data-reject]').forEach((b) => { b.onclick = () => decide(Number(b.dataset.reject), 'reject'); });
  view().querySelectorAll('[data-doc]').forEach((b) => {
    b.onclick = () => window.open(`/api/leave-requests/${b.dataset.doc}/attachment`, '_blank');
  });
}

/* ------------------------------------------------------------------ calendar */
async function renderCalendar() {
  loading('Building the calendar…');
  const month = state.calMonth || new Date().toISOString().slice(0, 7);
  const data = await api(`/calendar?month=${month}`);
  const types = await api('/leave-types');
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const leading = (firstWeekday + 6) % 7; // Monday-first grid
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayIso = new Date().toISOString().slice(0, 10);

  const cells = [];
  for (let i = 0; i < leading; i += 1) cells.push('<div class="cal-cell other"></div>');
  for (let d = 1; d <= daysInMonth; d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const people = data.days[date] || [];
    const overlap = data.overlaps.some((o) => o.date === date);
    const classes = ['cal-cell'];
    if (dow === 0 || dow === 6) classes.push('weekend');
    if (date === todayIso) classes.push('today');
    if (overlap) classes.push('overlap');
    cells.push(`<div class="${classes.join(' ')}">
      <span class="cal-date">${d}${overlap ? ' ⚠' : ''}</span>
      ${people.slice(0, 3).map((p) => `<span class="cal-chip" style="background:${esc(p.color)}" title="${esc(p.employeeName)} · ${esc(p.leaveType)}">${esc(p.employeeName.split(' ')[0])}</span>`).join('')}
      ${people.length > 3 ? `<span class="muted">+${people.length - 3} more</span>` : ''}
    </div>`);
  }

  const legend = state.leaveTypes.map((t) => `<span><span class="dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</span>`).join('');

  view().innerHTML = `
    <div class="page-head">
      <div><h1>Team calendar</h1><p class="muted">Approved leave, colour-coded by type. ⚠ marks days where two or more people are away.</p></div>
      <div class="btn-row">
        <button class="btn btn-outline btn-sm" id="prevMonth">← Previous</button>
        <button class="btn btn-outline btn-sm" id="nextMonth">Next →</button>
      </div>
    </div>
    <section class="card">
      <div class="cal-head">
        <h2>${new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
        <div class="legend">${legend}</div>
      </div>
      <div class="cal-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
    </section>
    <section class="card" style="margin-top:16px">
      <h2>Overlapping leave this month</h2>
      ${data.overlaps.length ? `<div class="overlap-list">${data.overlaps.map((o) => `
        <div class="overlap-item"><strong>${fmtDate(o.date)}:</strong>
          ${o.people.map((p) => `${esc(p.employeeName)} (${esc(p.leaveType)})`).join(', ')} are all away.</div>`).join('')}</div>`
        : emptyBox('🙌', 'No overlaps this month', 'Nobody shares the same leave day in this month.')}
    </section>`;

  el('prevMonth').onclick = () => { state.calMonth = shiftMonth(month, -1); renderCalendar().catch(failure); };
  el('nextMonth').onclick = () => { state.calMonth = shiftMonth(month, 1); renderCalendar().catch(failure); };
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- notifications */
async function renderNotifications() {
  loading('Loading notifications…');
  const data = await api('/notifications');
  view().innerHTML = `
    <div class="page-head">
      <div><h1>Notifications</h1><p class="muted">${data.unreadCount} unread of ${data.notifications.length}</p></div>
      ${data.unreadCount ? '<button class="btn btn-outline btn-sm" id="readAll">Mark all as read</button>' : ''}
    </div>
    <section class="card">
      ${data.notifications.length ? data.notifications.map((n) => `
        <div class="notif ${n.isRead ? '' : 'unread'}">
          <div style="flex:1">
            <h3>${esc(n.title)}</h3>
            <p>${esc(n.body)}</p>
            <span class="muted">${fmtDateTime(n.createdAt)}</span>
          </div>
          ${n.isRead ? '' : `<button class="btn btn-sm btn-outline" data-read="${n.id}">Mark read</button>`}
        </div>`).join('')
        : emptyBox('🔔', 'No notifications yet', 'You will be told here when something happens to your leave.')}
    </section>`;
  setUnread(data.unreadCount);
  view().querySelectorAll('[data-read]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/notifications/${b.dataset.read}/read`, { method: 'POST' });
        renderNotifications();
      } catch (err) { toast(err.message, true); }
    };
  });
  const readAll = el('readAll');
  if (readAll) {
    readAll.onclick = async () => {
      try {
        await api('/notifications/read-all', { method: 'POST' });
        renderNotifications();
      } catch (err) { toast(err.message, true); }
    };
  }
}

/* ----------------------------------------------------------------- audit log */
async function renderAudit() {
  if (state.user.role !== 'admin') {
    view().innerHTML = '<div class="error-box">The audit log is for admins only.</div>';
    return;
  }
  loading('Loading the audit log…');
  const action = state.auditAction || '';
  const data = await api(`/audit-logs${action ? `?action=${encodeURIComponent(action)}` : ''}`);
  view().innerHTML = `
    <div class="page-head">
      <div><h1>Audit log</h1><p class="muted">Every submission, decision, cancellation and balance change. Records cannot be edited or deleted.</p></div>
    </div>
    <section class="card">
      <div class="field" style="max-width:320px">
        <label for="actionFilter">Filter by action</label>
        <select id="actionFilter">
          <option value="">All actions</option>
          ${data.actions.map((a) => `<option value="${esc(a)}" ${action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        </select>
      </div>
      ${data.logs.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Change</th><th>Note</th></tr></thead>
        <tbody>${data.logs.map((l) => `<tr>
          <td>${fmtDateTime(l.createdAt)}</td>
          <td>${esc(l.actorName || 'system')}</td>
          <td><strong>${esc(l.action)}</strong></td>
          <td>${esc(l.entityType)} #${esc(l.entityId ?? '—')}</td>
          <td class="audit-change">${l.before ? `from ${esc(JSON.stringify(l.before))}` : ''}${l.before && l.after ? ' → ' : ''}${l.after ? `to ${esc(JSON.stringify(l.after))}` : ''}</td>
          <td class="muted">${esc(l.note || '')}</td>
        </tr>`).join('')}</tbody></table></div>`
        : emptyBox('📝', 'Nothing logged yet', 'Actions will be recorded here as they happen.')}
    </section>`;
  el('actionFilter').onchange = (e) => {
    state.auditAction = e.target.value;
    renderAudit().catch(failure);
  };
}

/* -------------------------------------------------------------------- router */
const ROUTES = {
  '#/dashboard': renderDashboard,
  '#/apply': renderApply,
  '#/requests': renderRequests,
  '#/approvals': renderApprovals,
  '#/calendar': renderCalendar,
  '#/notifications': renderNotifications,
  '#/audit': renderAudit,
};

async function router() {
  if (!state.user) {
    renderAuth();
    return;
  }
  renderChrome();
  highlightNav();
  const hash = location.hash || '#/dashboard';
  const page = ROUTES[hash] || renderDashboard;
  try {
    await page();
  } catch (err) {
    failure(err);
  }
}

/* ---------------------------------------------------------------------- boot */
el('signOutBtn').onclick = async () => {
  try { await api('/auth/signout', { method: 'POST' }); } catch { /* ignore */ }
  state.user = null;
  state.csrf = null;
  location.hash = '#/dashboard';
  renderAuth();
  toast('Signed out.');
};

window.addEventListener('hashchange', () => {
  if (state.user) router();
});

(async function boot() {
  try {
    const data = await api('/auth/me');
    state.user = data.user;
    state.csrf = data.csrfToken;
  } catch {
    state.user = null;
  }
  router();
  setInterval(refreshUnread, 60000);
})();
