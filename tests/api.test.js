'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Keep tests fast and throw-away: their own data folder, cheap password hashing.
process.env.DATA_DIR = path.join(os.tmpdir(), `lms-test-${Date.now()}`);
process.env.SCRYPT_N = '1024';
process.env.MAX_UPLOAD_MB = '1';
process.env.SIGNIN_MAX_FAILURES = '5';
process.env.SIGNIN_WINDOW_MINUTES = '15';

const { createApp } = require('../server/app');
const { config } = require('../server/lib/env');
const { seed, PASSWORD } = require('../server/seed');
const dates = require('../server/lib/dates');

const ACCOUNTS = {
  admin: 'anita.admin@example.test',
  manager: 'rajesh.manager@example.test',
  otherManager: 'sonal.manager@example.test',
  employee: 'priya.employee@example.test',
  employee2: 'arjun.employee@example.test',
  employee3: 'meera.employee@example.test',
  finance: 'farah.employee@example.test',
};

let server;
let base;
let db;

/* ------------------------------------------------------------------ client */

// The response has to hand back every Set-Cookie value, otherwise the client
// below never stores the session cookie and every later request looks signed
// out. `Headers.getSetCookie()` only exists on newer runtimes (and on Node 18
// it is missing entirely), so fall back to the combined `set-cookie` header and
// split it on the commas that start a new cookie name - never on the commas
// inside an `Expires=Wed, 21 Oct 2026 ...` date.
function readSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const list = headers.getSetCookie();
    if (Array.isArray(list) && list.length > 0) return list;
  }
  const raw = headers.get('set-cookie');
  if (!raw) return [];
  return raw
    .split(/,(?=\s*[^;=,\s]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function makeClient() {
  const cookieJar = new Map();
  let csrf = null;

  async function request(method, url, { body, form, headers = {} } = {}) {
    const opts = { method, headers: { ...headers }, redirect: 'manual' };
    const cookie = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) opts.headers.cookie = cookie;
    if (method !== 'GET' && csrf) opts.headers['x-csrf-token'] = csrf;
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (form) opts.body = form;

    const res = await fetch(`${base}${url}`, opts);
    for (const raw of readSetCookies(res.headers)) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1);
      if (!value || /Max-Age=0/i.test(raw)) cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    return { status: res.status, data, headers: res.headers };
  }

  return {
    request,
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, { body }),
    postForm: (url, form) => request('POST', url, { form }),
    async signin(email, password = PASSWORD) {
      const res = await request('POST', '/api/auth/signin', { body: { email, password } });
      if (res.status === 200) csrf = res.data.csrfToken;
      return res;
    },
    async signup(payload) {
      const res = await request('POST', '/api/auth/signup', { body: payload });
      if (res.status === 201) csrf = res.data.csrfToken;
      return res;
    },
    clearCsrf() { csrf = null; },
    setCsrf(value) { csrf = value; },
  };
}

async function as(role) {
  const client = makeClient();
  const res = await client.signin(ACCOUNTS[role]);
  assert.equal(res.status, 200, `sign-in failed for ${role}`);
  return client;
}

function nextMonday(weeksAhead = 1) {
  const today = dates.todayIso();
  let cursor = dates.addDays(today, 1);
  while (new Date(`${cursor}T00:00:00Z`).getUTCDay() !== 1) cursor = dates.addDays(cursor, 1);
  return dates.addDays(cursor, weeksAhead * 7);
}

// Leave is balanced per calendar year and only the current year is seeded, so a
// request placed "a few weeks ahead" late in the year lands in a year that has
// no entitlement yet. Such a request is refused for "0 days remaining" before
// the rule under test is ever reached, so walk back week by week to the last
// Monday that is still inside the current year.
function nextMondayInBalanceYear(weeksAhead = 1) {
  const year = dates.todayIso().slice(0, 4);
  let cursor = nextMonday(weeksAhead);
  while (cursor.slice(0, 4) !== year) cursor = dates.addDays(cursor, -7);
  return cursor;
}

async function applyLeave(client, { type, start, end, reason, halfDay }) {
  const types = await client.get('/api/leave-types');
  const leaveType = type
    ? types.data.leaveTypes.find((t) => t.code === type)
    : types.data.leaveTypes[0];
  return client.post('/api/leave-requests', {
    leaveTypeId: leaveType.id,
    startDate: start,
    endDate: end,
    reason: reason || 'Automated test request for the suite.',
    halfDay: halfDay || 'none',
  });
}

/* -------------------------------------------------------------------- setup */

// Isolation: every test gets its own throw-away database, its own upload folder
// and its own server, seeded from scratch just before it starts and deleted
// afterwards. Nothing a test does can leak into the next one, so failures point
// at the behaviour under test and two runs of the suite give the same numbers.
let startCount = 0;

async function startFreshApp() {
  startCount += 1;
  const dir = path.join(os.tmpdir(), `lms-test-${process.pid}-${startCount}-${Date.now()}`);
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  config.uploadDir = uploadDir;

  const ctx = createApp({ dbPath: path.join(dir, 'test.db') });
  seed(ctx.db);

  const instance = ctx.app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    instance.once('listening', resolve);
    instance.once('error', reject);
  });

  return {
    db: ctx.db,
    base: `http://127.0.0.1:${instance.address().port}`,
    async stop() {
      await new Promise((resolve) => instance.close(resolve));
      try { ctx.db.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run one test against its own fresh database and server. */
function isolatedTest(name, body) {
  test(name, async () => {
    const fresh = await startFreshApp();
    db = fresh.db;
    base = fresh.base;
    try {
      await body();
    } finally {
      db = null;
      base = null;
      await fresh.stop();
    }
  });
}

/* ============================================================ date counting */
isolatedTest('weekends are not counted as leave days', () => {
  assert.equal(dates.countWorkingDays('2026-11-16', '2026-11-20'), 5); // Mon-Fri
  assert.equal(dates.countWorkingDays('2026-11-20', '2026-11-23'), 2); // Fri + Mon
  assert.equal(dates.countWorkingDays('2026-11-21', '2026-11-22'), 0); // Sat + Sun
});

isolatedTest('a half day counts as half a day', () => {
  assert.equal(dates.countLeaveDays('2026-11-18', '2026-11-18', 'am'), 0.5);
  assert.equal(dates.countLeaveDays('2026-11-18', '2026-11-18', 'none'), 1);
});

isolatedTest('date ranges are validated', () => {
  assert.equal(dates.isValidDate('2026-02-30'), false);
  assert.equal(dates.isValidDate('2026-02-28'), true);
  assert.deepEqual(dates.overlapDates('2026-11-16', '2026-11-18', '2026-11-18', '2026-11-20'), ['2026-11-18']);
  assert.deepEqual(dates.overlapDates('2026-11-16', '2026-11-17', '2026-11-18', '2026-11-20'), []);
});

/* ============================================================ authentication */
isolatedTest('health endpoint answers without signing in', async () => {
  const client = makeClient();
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

isolatedTest('valid credentials sign in and reveal the role', async () => {
  const client = makeClient();
  const res = await client.signin(ACCOUNTS.employee);
  assert.equal(res.status, 200);
  assert.equal(res.data.user.role, 'employee');
  assert.equal(res.data.user.email, ACCOUNTS.employee);
  assert.ok(res.data.csrfToken);
});

isolatedTest('passwords are stored as scrypt hashes, never plain text', () => {
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(ACCOUNTS.employee);
  assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.ok(!row.password_hash.includes(PASSWORD));
});

isolatedTest('a wrong password is refused', async () => {
  const client = makeClient();
  const res = await client.signin(ACCOUNTS.employee, 'WrongPassword1');
  assert.equal(res.status, 401);
  assert.equal(res.data.error.code, 'unauthorized');
});

isolatedTest('an unknown e-mail is refused', async () => {
  const client = makeClient();
  const res = await client.signin('nobody@example.test');
  assert.equal(res.status, 401);
});

isolatedTest('repeated failures lock the account out for a while', async () => {
  const client = makeClient();
  for (let i = 0; i < 5; i += 1) await client.signin('meera.employee@example.test', `nope${i}1`);
  const res = await client.signin('meera.employee@example.test', PASSWORD);
  assert.equal(res.status, 429);
  db.prepare('DELETE FROM signin_attempts WHERE email = ?').run('meera.employee@example.test');
});

isolatedTest('private endpoints reject an unauthenticated caller', async () => {
  const client = makeClient();
  for (const url of ['/api/dashboard', '/api/leave-requests', '/api/balances', '/api/notifications', '/api/calendar']) {
    const res = await client.get(url);
    assert.equal(res.status, 401, `${url} should be 401`);
    assert.ok(res.data.error.message);
  }
});

isolatedTest('state-changing requests need the form token (CSRF guard)', async () => {
  const client = await as('employee');
  client.clearCsrf();
  const res = await client.post('/api/leave-requests', { reason: 'no token here at all' });
  assert.equal(res.status, 403);
});

isolatedTest('sign-up creates an employee only, never an admin', async () => {
  const client = makeClient();
  const res = await client.signup({
    name: 'Test Signup User',
    email: `signup.${Date.now()}@example.test`,
    password: 'Password123',
    role: 'admin',
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.user.role, 'employee');
});

isolatedTest('sign-up rejects a weak password and a duplicate e-mail', async () => {
  const client = makeClient();
  const weak = await client.signup({ name: 'Weak Pass', email: `weak.${Date.now()}@example.test`, password: 'abc' });
  assert.equal(weak.status, 422);
  const dup = makeClient().signup({ name: 'Priya Again', email: ACCOUNTS.employee, password: 'Password123' });
  assert.equal((await dup).status, 409);
});

/* ============================================================== permissions */
isolatedTest('an employee cannot reach manager or admin endpoints', async () => {
  const client = await as('employee');
  const audit = await client.get('/api/audit-logs');
  assert.equal(audit.status, 403);

  const team = await client.get('/api/leave-requests?scope=team');
  assert.equal(team.status, 403);

  const all = await client.get('/api/leave-requests?scope=all');
  assert.equal(all.status, 403);

  const decisions = await client.post('/api/leave-requests/1/decision', { action: 'approve' });
  assert.equal(decisions.status, 403);

  const createUser = await client.post('/api/users', {
    name: 'Sneaky Admin', email: `sneaky.${Date.now()}@example.test`, password: 'Password123', role: 'admin',
  });
  assert.equal(createUser.status, 403);
});

isolatedTest('a manager cannot reach admin-only endpoints', async () => {
  const client = await as('manager');
  assert.equal((await client.get('/api/audit-logs')).status, 403);
  // Reversing is a POST: submit it rather than reading the address.
  assert.equal((await client.post('/api/leave-requests/1/reverse', {})).status, 403);
  const createAdmin = await client.post('/api/users', {
    name: 'Manager Made Admin', email: `mm.${Date.now()}@example.test`, password: 'Password123', role: 'admin',
  });
  assert.equal(createAdmin.status, 403);
});

isolatedTest('an employee cannot read another employee\'s balance', async () => {
  const client = await as('employee');
  const me = (await client.get('/api/auth/me')).data.user;
  const other = db.prepare('SELECT id FROM users WHERE email = ?').get(ACCOUNTS.employee3);
  const res = await client.get(`/api/balances?userId=${other.id}`);
  assert.equal(res.status, 403);
  const own = await client.get(`/api/balances?userId=${me.id}`);
  assert.equal(own.status, 200);
});

isolatedTest('a manager only sees their own team\'s balances', async () => {
  const client = await as('manager');
  const outsider = db.prepare('SELECT id FROM users WHERE email = ?').get(ACCOUNTS.finance);
  const res = await client.get(`/api/balances?userId=${outsider.id}`);
  assert.equal(res.status, 403);
});

/* ============================================================ leave requests */
isolatedTest('an employee applies for leave and it starts as pending', async () => {
  const client = await as('employee');
  const start = nextMonday(3);
  const res = await applyLeave(client, { type: 'casual', start, end: dates.addDays(start, 1) });
  assert.equal(res.status, 201);
  assert.equal(res.data.request.status, 'pending');
  assert.equal(res.data.workingDays, 2);
});

isolatedTest('the balance only drops when a request is approved', async () => {
  const employee = await as('employee');
  const manager = await as('manager');
  const before = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'sick');

  const start = nextMonday(4);
  const created = await applyLeave(employee, { type: 'sick', start, end: dates.addDays(start, 2) });
  assert.equal(created.status, 201);

  const mid = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'sick');
  assert.equal(mid.usedDays, before.usedDays, 'pending leave must not be deducted');

  const decided = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, {
    action: 'approve', comment: 'Approved in the test suite.',
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.data.request.status, 'approved');

  const afterBalance = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'sick');
  assert.equal(afterBalance.usedDays, before.usedDays + 3);
  assert.equal(afterBalance.remainingDays, before.remainingDays - 3);
});

isolatedTest('cancelling an approved leave puts the days back', async () => {
  const employee = await as('employee');
  const manager = await as('manager');
  const start = nextMonday(5);
  const created = await applyLeave(employee, { type: 'annual', start, end: dates.addDays(start, 1) });
  await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve', comment: 'ok' });

  const usedAfterApproval = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'annual').usedDays;
  const cancelled = await employee.post(`/api/leave-requests/${created.data.request.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.request.status, 'cancelled');

  const usedAfterCancel = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'annual').usedDays;
  assert.equal(usedAfterCancel, usedAfterApproval - 2);
});

isolatedTest('a half day is deducted as 0.5', async () => {
  const employee = await as('employee');
  const manager = await as('manager');
  // Balances are seeded per calendar year, and nextMonday(6) from late November
  // already lands in the next year, where no balance row exists yet - so the
  // request was refused for "no days left" rather than testing the half day.
  // Walk back to the last Monday that is still inside the seeded year.
  const day = (() => {
    let cursor = nextMonday(6);
    const year = new Date().getFullYear();
    while (Number(cursor.slice(0, 4)) !== year) cursor = dates.addDays(cursor, -7);
    return cursor;
  })();
  const before = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'casual');
  const created = await applyLeave(employee, { type: 'casual', start: day, end: day, halfDay: 'pm' });
  assert.equal(created.status, 201);
  assert.equal(created.data.workingDays, 0.5);
  await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve', comment: 'ok' });
  const after = (await employee.get('/api/balances')).data.balances.find((b) => b.code === 'casual');
  assert.equal(after.usedDays, before.usedDays + 0.5);
});

isolatedTest('a request for more days than the remaining balance is refused', async () => {
  const client = await as('employee');
  const start = nextMonday(8);
  const res = await applyLeave(client, { type: 'casual', start, end: dates.addDays(start, 100), reason: 'Far too long a holiday for the balance.' });
  assert.equal(res.status, 422);
  assert.match(JSON.stringify(res.data.error), /balance|days/i);
});

isolatedTest('invalid input is rejected with field messages', async () => {
  const client = await as('employee');
  const start = nextMonday(2);

  const backwards = await applyLeave(client, { type: 'annual', start: dates.addDays(start, 3), end: start });
  assert.equal(backwards.status, 422);

  const noReason = await client.post('/api/leave-requests', {
    leaveTypeId: 1, startDate: start, endDate: start,
  });
  assert.equal(noReason.status, 422);

  const shortReason = await applyLeave(client, { type: 'annual', start, end: start, reason: 'short' });
  assert.equal(shortReason.status, 422);

  const badType = await client.post('/api/leave-requests', {
    leaveTypeId: 999999, startDate: start, endDate: start, reason: 'A perfectly good reason here',
  });
  assert.ok([400, 422].includes(badType.status));

  const absurd = await applyLeave(client, { type: 'annual', start, end: dates.addDays(start, 900) });
  assert.equal(absurd.status, 422);

  const badDate = await client.post('/api/leave-requests', {
    leaveTypeId: 1, startDate: '2026-02-31', endDate: '2026-03-02', reason: 'A perfectly good reason here',
  });
  assert.equal(badDate.status, 422);

  const weekendOnly = await applyLeave(client, { type: 'annual', start: '2026-11-21', end: '2026-11-22' });
  assert.equal(weekendOnly.status, 422);
});

/* ================================================================ approvals */
isolatedTest('rejection needs a comment, and works with one', async () => {
  const employee = await as('employee');
  const manager = await as('manager');
  const start = nextMondayInBalanceYear(7);
  const created = await applyLeave(employee, { type: 'casual', start, end: start });

  const noComment = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'reject' });
  assert.equal(noComment.status, 422);

  const rejected = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, {
    action: 'reject', comment: 'Team is at a conference that day.',
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.request.status, 'rejected');
  assert.equal(rejected.data.request.decisionComment, 'Team is at a conference that day.');
});

isolatedTest('the same request cannot be approved twice', async () => {
  const employee = await as('employee');
  const manager = await as('manager');
  const start = nextMondayInBalanceYear(9);
  const created = await applyLeave(employee, { type: 'sick', start, end: start });
  const first = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve' });
  assert.equal(first.status, 200);
  const second = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'reject', comment: 'changed my mind' });
  assert.equal(second.status, 409);
});

isolatedTest('nobody can approve their own leave', async () => {
  const manager = await as('manager');
  const start = nextMondayInBalanceYear(10);
  const created = await applyLeave(manager, { type: 'annual', start, end: start });
  assert.equal(created.status, 201);
  const res = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve' });
  assert.equal(res.status, 403);
});

isolatedTest('a manager cannot decide someone outside their team', async () => {
  const finance = await as('finance');
  const manager = await as('manager');
  const start = nextMonday(11);
  const created = await applyLeave(finance, { type: 'casual', start, end: start });
  const res = await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve' });
  assert.equal(res.status, 403);
});

isolatedTest('an admin can decide anything and reverse an approved leave', async () => {
  const employee = await as('employee');
  const admin = await as('admin');
  const start = nextMonday(12);
  const created = await applyLeave(employee, { type: 'annual', start, end: start });
  const approved = await admin.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve', comment: 'approved by admin' });
  assert.equal(approved.status, 200);
  const reversed = await admin.post(`/api/leave-requests/${created.data.request.id}/reverse`, {});
  assert.equal(reversed.status, 200);
  assert.equal(reversed.data.request.status, 'cancelled');
});

/* ================================================================== overlap */
isolatedTest('overlapping leave is detected across people and types, but not otherwise', async () => {
  const employee = await as('employee');
  const employee2 = await as('employee2');
  const start = nextMonday(13);

  const first = await applyLeave(employee, { type: 'annual', start, end: dates.addDays(start, 2) });
  assert.equal(first.status, 201);

  const sameType = await employee2.request('GET', `/api/overlaps?startDate=${start}&endDate=${dates.addDays(start, 1)}`);
  assert.equal(sameType.data.hasOverlap, true);
  assert.ok(sameType.data.conflicts.length >= 1);

  const otherType = await applyLeave(employee2, { type: 'sick', start: dates.addDays(start, 1), end: dates.addDays(start, 3) });
  assert.equal(otherType.status, 201);
  assert.ok(otherType.data.conflicts.length >= 1, 'a different leave type still overlaps');

  const noOverlap = await employee.request('GET', `/api/overlaps?startDate=${dates.addDays(start, 10)}&endDate=${dates.addDays(start, 11)}`);
  assert.equal(noOverlap.data.hasOverlap, false);

  const weekend = await employee.request('GET', `/api/overlaps?startDate=2026-11-21&endDate=2026-11-22`);
  assert.equal(weekend.status, 200);
  assert.equal(weekend.data.hasOverlap, false);
});

isolatedTest('the calendar lists approved leave days and flags overlaps', async () => {
  const client = await as('employee');
  const month = nextMonday(14).slice(0, 7);
  const res = await client.get(`/api/calendar?month=${month}`);
  assert.equal(res.status, 200);
  assert.ok(res.data.days, 'calendar days map');
  assert.ok(Array.isArray(res.data.overlaps));
  const bad = await client.get('/api/calendar?month=2026-13');
  assert.equal(bad.status, 400);
});

/* ================================================================== uploads */
isolatedTest('a PDF document is stored and only visible to the right people', async () => {
  const employee = await as('employee');
  const outsider = await as('finance');
  const types = (await employee.get('/api/leave-types')).data.leaveTypes;
  const start = nextMonday(15);

  const form = new FormData();
  form.append('leaveTypeId', String(types.find((t) => t.code === 'sick').id));
  form.append('startDate', start);
  form.append('endDate', start);
  form.append('halfDay', 'none');
  form.append('reason', 'Medical certificate attached for the test suite.');
  form.append('attachment', new Blob([Buffer.from('%PDF-1.4\n% test certificate\n')], { type: 'application/pdf' }), 'certificate.pdf');

  const created = await employee.postForm('/api/leave-requests', form);
  assert.equal(created.status, 201);
  const id = created.data.request.id;

  const mine = await employee.get(`/api/leave-requests/${id}/attachment`);
  assert.equal(mine.status, 200);
  assert.match(String(mine.headers.get('content-disposition')), /attachment/);

  const other = await outsider.get(`/api/leave-requests/${id}/attachment`);
  assert.equal(other.status, 403);
});

isolatedTest('an executable or text file is refused as a document', async () => {
  const employee = await as('employee');
  const types = (await employee.get('/api/leave-types')).data.leaveTypes;
  const start = nextMonday(16);
  const form = new FormData();
  form.append('leaveTypeId', String(types[0].id));
  form.append('startDate', start);
  form.append('endDate', start);
  form.append('reason', 'Trying to attach the wrong kind of file.');
  form.append('attachment', new Blob([Buffer.from('#!/bin/sh\necho hi\n')], { type: 'application/pdf' }), 'evil.pdf');
  const res = await employee.postForm('/api/leave-requests', form);
  assert.equal(res.status, 400);
});

isolatedTest('an oversized document is refused', async () => {
  const employee = await as('employee');
  const types = (await employee.get('/api/leave-types')).data.leaveTypes;
  const start = nextMonday(17);
  const big = Buffer.alloc(2 * 1024 * 1024, 0x25);
  const form = new FormData();
  form.append('leaveTypeId', String(types[0].id));
  form.append('startDate', start);
  form.append('endDate', start);
  form.append('reason', 'This attachment is far too large for the server.');
  form.append('attachment', new Blob([big], { type: 'application/pdf' }), 'huge.pdf');
  const res = await employee.postForm('/api/leave-requests', form);
  assert.equal(res.status, 413);
});

/* ================================================================= failures */
isolatedTest('missing ids give 404 and malformed ids give 400, with clean JSON', async () => {
  const client = await as('employee');
  const missing = await client.get('/api/leave-requests/999999');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'not_found');

  const malformed = await client.get('/api/leave-requests/abc');
  assert.equal(malformed.status, 400);
  assert.ok(malformed.data.error.message);

  const unknownRoute = await client.get('/api/does-not-exist');
  assert.equal(unknownRoute.status, 404);
  assert.ok(unknownRoute.data.error.message);
  assert.ok(!JSON.stringify(unknownRoute.data).includes('at '), 'no stack trace leaks');
});

isolatedTest('another employee\'s request cannot be read or cancelled', async () => {
  const owner = await as('employee');
  const outsider = await as('finance');
  const start = nextMonday(18);
  const created = await applyLeave(owner, { type: 'casual', start, end: start });

  const read = await outsider.get(`/api/leave-requests/${created.data.request.id}`);
  assert.equal(read.status, 403);

  const cancel = await outsider.post(`/api/leave-requests/${created.data.request.id}/cancel`, {});
  assert.equal(cancel.status, 403);
});

isolatedTest('the audit log records actions and is read-only', async () => {
  const admin = await as('admin');
  const res = await admin.get('/api/audit-logs');
  assert.equal(res.status, 200);
  assert.ok(res.data.logs.length > 0);
  const actions = res.data.logs.map((l) => l.action);
  assert.ok(actions.some((a) => a.startsWith('leave_request.')));
  assert.ok(actions.some((a) => a.startsWith('leave_balance.')) || actions.some((a) => a === 'leave_request.decision'));

  const filtered = await admin.get('/api/audit-logs?action=leave_request.create');
  assert.equal(filtered.status, 200);
  assert.ok(filtered.data.logs.every((l) => l.action === 'leave_request.create'));

  const overwrite = await admin.request('PATCH', '/api/audit-logs/1', { body: { action: 'nothing' } });
  assert.equal(overwrite.status, 404);
  const deleteAttempt = await admin.request('DELETE', '/api/audit-logs/1');
  assert.equal(deleteAttempt.status, 404);
});

isolatedTest('notifications reach the manager and the employee, and can be marked read', async () => {
  const employee = await as('employee');
  const manager = await as('manager');
  const start = nextMonday(19);
  const created = await applyLeave(employee, { type: 'annual', start, end: start });
  assert.equal(created.status, 201);

  const managerNotes = await manager.get('/api/notifications');
  assert.ok(managerNotes.data.notifications.some((n) => n.type.includes('submitted')));

  await manager.post(`/api/leave-requests/${created.data.request.id}/decision`, { action: 'approve', comment: 'ok' });
  const employeeNotes = await employee.get('/api/notifications');
  const decision = employeeNotes.data.notifications.find((n) => n.type.includes('approved'));
  assert.ok(decision, 'employee is told about the approval');
  assert.ok(employeeNotes.data.unreadCount > 0);

  const read = await employee.post(`/api/notifications/${decision.id}/read`, {});
  assert.equal(read.status, 200);
  const afterRead = await employee.get('/api/notifications/unread-count');
  assert.equal(afterRead.data.unreadCount, employeeNotes.data.unreadCount - 1);
});

isolatedTest('signing out ends the session', async () => {
  const client = await as('employee');
  assert.equal((await client.get('/api/dashboard')).status, 200);
  const out = await client.post('/api/auth/signout', {});
  assert.equal(out.status, 200);
  assert.equal((await client.get('/api/dashboard')).status, 401);
});

isolatedTest('the dashboard shows balances, pending and history for the signed-in user', async () => {
  const client = await as('employee');
  const res = await client.get('/api/dashboard');
  assert.equal(res.status, 200);
  assert.ok(res.data.balances.length > 0);
  assert.ok('pending' in res.data && 'approved' in res.data);
});

isolatedTest('the calendar endpoint refuses a bad month', async () => {
  const client = await as('manager');
  assert.equal((await client.get('/api/calendar?month=nope')).status, 400);
});
