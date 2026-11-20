'use strict';

/**
 * Demo data so the app can be tried immediately.
 *
 *   node server/seed.js          # only fills an empty database
 *   node server/seed.js --reset  # wipes the database and uploads, then reseeds
 *
 * All names, e-mails and passwords here are made up.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/env');
const { openDatabase } = require('./db');
const { hashPassword } = require('./lib/password');
const { createLeaveService } = require('./services/leave');
const { addDays, todayIso, monthBounds } = require('./lib/dates');

const PASSWORD = 'Password@123';

const USERS = [
  { name: 'Anita Deshmukh', email: 'anita.admin@example.test', role: 'admin', department: 'People Operations' },
  { name: 'Rajesh Kulkarni', email: 'rajesh.manager@example.test', role: 'manager', department: 'Engineering' },
  { name: 'Sonal Verma', email: 'sonal.manager@example.test', role: 'manager', department: 'Finance' },
  { name: 'Priya Nair', email: 'priya.employee@example.test', role: 'employee', department: 'Engineering', managerEmail: 'rajesh.manager@example.test' },
  { name: 'Arjun Mehta', email: 'arjun.employee@example.test', role: 'employee', department: 'Engineering', managerEmail: 'rajesh.manager@example.test' },
  { name: 'Meera Joshi', email: 'meera.employee@example.test', role: 'employee', department: 'Engineering', managerEmail: 'rajesh.manager@example.test' },
  { name: 'Sameer Khan', email: 'sameer.employee@example.test', role: 'employee', department: 'Engineering', managerEmail: 'rajesh.manager@example.test' },
  { name: 'Farah Sheikh', email: 'farah.employee@example.test', role: 'employee', department: 'Finance', managerEmail: 'sonal.manager@example.test' },
];

const LEAVE_TYPES = [
  { name: 'Annual Leave', code: 'annual', default_days: 20, color: '#2563eb' },
  { name: 'Sick Leave', code: 'sick', default_days: 10, color: '#dc2626' },
  { name: 'Casual Leave', code: 'casual', default_days: 8, color: '#d97706' },
  { name: 'Unpaid Leave', code: 'unpaid', default_days: 10, color: '#475569' },
];

function wipe() {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${config.dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  if (fs.existsSync(config.uploadDir)) {
    fs.rmSync(config.uploadDir, { recursive: true, force: true });
  }
}

function nextWeekday(date) {
  let cursor = date;
  while ([0, 6].includes(new Date(`${cursor}T00:00:00Z`).getUTCDay())) {
    cursor = addDays(cursor, 1);
  }
  return cursor;
}

function dayOfMonth(month, day) {
  const { end } = monthBounds(month);
  const safe = Math.min(day, Number(end.slice(8, 10)));
  return `${month}-${String(safe).padStart(2, '0')}`;
}

function seed(db) {
  const passwords = new Map();
  const hash = (email) => {
    if (!passwords.has(email)) passwords.set(email, hashPassword(PASSWORD));
    return passwords.get(email);
  };

  const insertType = db.prepare(
    `INSERT INTO leave_types (name, code, default_days, color)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, default_days = excluded.default_days, color = excluded.color`,
  );
  for (const type of LEAVE_TYPES) insertType.run(type.name, type.code, type.default_days, type.color);

  const year = new Date().getFullYear();
  const insertBalance = db.prepare(
    `INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days)
     SELECT ?, id, ?, default_days, 0 FROM leave_types WHERE is_active = 1
     ON CONFLICT(user_id, leave_type_id, year) DO NOTHING`,
  );

  const byEmail = new Map();
  const insertUser = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, manager_id, department)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  // Managers and admins first, so employees can point at their manager.
  for (const user of USERS) {
    if (user.managerEmail) continue;
    const info = insertUser.run(user.name, user.email, hash(user.email), user.role, null, user.department);
    const id = Number(info.lastInsertRowid);
    byEmail.set(user.email, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    insertBalance.run(id, year);
  }
  for (const user of USERS) {
    if (!user.managerEmail) continue;
    const manager = byEmail.get(user.managerEmail);
    const info = insertUser.run(user.name, user.email, hash(user.email), user.role, manager.id, user.department);
    const id = Number(info.lastInsertRowid);
    byEmail.set(user.email, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    insertBalance.run(id, year);
  }

  const types = new Map(
    db.prepare('SELECT * FROM leave_types').all().map((row) => [row.code, row]),
  );
  const user = (email) => byEmail.get(email);

  const leave = createLeaveService(db);
  const submit = (email, code, startDate, endDate, reason, extra = {}) =>
    leave.createRequest({
      user: user(email),
      leaveTypeId: types.get(code).id,
      startDate,
      endDate,
      halfDay: extra.halfDay || 'none',
      reason,
      ip: '127.0.0.1',
    }).request;

  const manager = user('rajesh.manager@example.test');
  const admin = user('anita.admin@example.test');
  const month = todayIso().slice(0, 7);
  const today = todayIso();

  // --- an overlapping pair of approved leaves in the current month ----------
  const overlapStart = nextWeekday(dayOfMonth(month, 9));
  const overlapEnd = addDays(overlapStart, 4); // Mon -> Fri
  const secondStart = addDays(overlapStart, 2); // Wed, overlapping Thu/Fri

  const r1 = submit('priya.employee@example.test', 'annual', overlapStart, overlapEnd,
    'Family wedding out of town, travelling back on the Sunday.');
  leave.decide({ requestId: r1.id, actor: manager, action: 'approve', comment: 'Approved, enjoy the wedding.', ip: '127.0.0.1' });

  const r2 = submit('arjun.employee@example.test', 'sick', secondStart, overlapEnd,
    'Doctor advised three days of rest for a back strain.');
  leave.decide({ requestId: r2.id, actor: manager, action: 'approve', comment: 'Get well soon.', ip: '127.0.0.1' });

  // --- a rejected request ---------------------------------------------------
  const rejectedStart = nextWeekday(dayOfMonth(month, 2));
  const r3 = submit('meera.employee@example.test', 'casual', rejectedStart, addDays(rejectedStart, 1),
    'Need a day for some personal paperwork at the bank.');
  leave.decide({
    requestId: r3.id,
    actor: manager,
    action: 'reject',
    comment: 'We are short-staffed on the release day, please pick another date.',
    ip: '127.0.0.1',
  });

  // --- a pending request the manager can act on ----------------------------
  const pendingStart = nextWeekday(addDays(today, 4));
  submit('meera.employee@example.test', 'annual', pendingStart, addDays(pendingStart, 2),
    'Planned short trip with family, booked months ago.');

  // --- a pending single day for the "cancel my own request" demo -----------
  const cancelStart = nextWeekday(addDays(today, 1));
  submit('arjun.employee@example.test', 'casual', cancelStart, cancelStart,
    'Parents visiting, would like to take the day off to be with them.');

  // --- an approved half day -------------------------------------------------
  const halfStart = nextWeekday(addDays(today, 20));
  const r4 = submit('priya.employee@example.test', 'sick', halfStart, halfStart,
    'Dentist appointment in the morning, back after lunch.', { halfDay: 'am' });
  leave.decide({ requestId: r4.id, actor: manager, action: 'approve', comment: 'Fine, thanks for the notice.', ip: '127.0.0.1' });

  // --- an approved leave that crosses into the next month ------------------
  const crossStart = nextWeekday(addDays(today, 10));
  const r5 = submit('sameer.employee@example.test', 'annual', crossStart, addDays(crossStart, 3),
    'Visiting relatives in another city, trains already booked.');
  leave.decide({ requestId: r5.id, actor: manager, action: 'approve', comment: 'Approved.', ip: '127.0.0.1' });

  // --- an approved leave for the Finance manager's team --------------------
  const financeStart = nextWeekday(addDays(today, 6));
  const r6 = submit('farah.employee@example.test', 'casual', financeStart, addDays(financeStart, 1),
    'Moving house this week, need two days.');
  leave.decide({ requestId: r6.id, actor: user('sonal.manager@example.test'), action: 'approve', comment: 'Approved.', ip: '127.0.0.1' });

  // One unread note for the admin so the badge has something in it.
  db.prepare(
    `INSERT INTO notifications (user_id, type, title, body) VALUES (?, 'system', ?, ?)`,
  ).run(
    admin.id,
    'Welcome to the leave system',
    'Demo data has been loaded. Try approving a request from the Approvals page, then look at the audit log.',
  );

  return {
    users: byEmail.size,
    requests: db.prepare('SELECT COUNT(*) AS n FROM leave_requests').get().n,
    year,
  };
}

function main() {
  const reset = process.argv.includes('--reset');
  if (reset) wipe();

  const db = openDatabase(config.dbPath);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0 && !reset) {
    console.log('The database already has data. Nothing to do (use --reset to rebuild it).');
    db.close();
    return;
  }
  if (existing > 0 && reset) {
    console.log('Database still has data after reset - re-run with a fresh data folder.');
  }
  const result = seed(db);
  db.close();
  console.log(`Seeded ${result.users} users and ${result.requests} leave requests for ${result.year}.`);
  console.log(`Demo password for every account: ${PASSWORD}`);
}

if (require.main === module) main();

module.exports = { seed, wipe, PASSWORD, USERS };
