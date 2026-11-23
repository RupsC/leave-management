'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  manager_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department    TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users(role);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT    NOT NULL,
  ip           TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS signin_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  ip         TEXT,
  success    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_signin_attempts_email_time ON signin_attempts(email, created_at);

CREATE TABLE IF NOT EXISTS leave_types (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,
  code              TEXT    NOT NULL UNIQUE,
  default_days      REAL    NOT NULL DEFAULT 0,
  color             TEXT    NOT NULL DEFAULT '#2563eb',
  requires_document INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  entitled_days REAL    NOT NULL DEFAULT 0,
  used_days     REAL    NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, leave_type_id, year),
  CHECK (entitled_days >= 0),
  CHECK (used_days >= 0)
);
CREATE INDEX IF NOT EXISTS idx_balances_user_year ON leave_balances(user_id, year);

CREATE TABLE IF NOT EXISTS leave_requests (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id    INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
  start_date       TEXT    NOT NULL,
  end_date         TEXT    NOT NULL,
  half_day         TEXT    NOT NULL DEFAULT 'none' CHECK (half_day IN ('none', 'am', 'pm')),
  working_days     REAL    NOT NULL,
  reason           TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_comment TEXT,
  decided_at       TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_date >= start_date),
  CHECK (working_days >= 0)
);
CREATE INDEX IF NOT EXISTS idx_requests_user_status  ON leave_requests(user_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_status_dates ON leave_requests(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_requests_dates        ON leave_requests(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_requests_type         ON leave_requests(leave_type_id);

CREATE TABLE IF NOT EXISTS decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  leave_request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  actor_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action           TEXT    NOT NULL
                     CHECK (action IN ('submit', 'approve', 'reject', 'cancel', 'reverse')),
  comment          TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_request ON decisions(leave_request_id);

CREATE TABLE IF NOT EXISTS attachments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  leave_request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  uploaded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  original_name    TEXT    NOT NULL,
  stored_name      TEXT    NOT NULL UNIQUE,
  mime_type        TEXT    NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_request ON attachments(leave_request_id);

CREATE TABLE IF NOT EXISTS notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  leave_request_id INTEGER REFERENCES leave_requests(id) ON DELETE SET NULL,
  is_read          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications(user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,
  entity_id   INTEGER,
  before_json TEXT,
  after_json  TEXT,
  note        TEXT,
  ip          TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_logs(entity_type, entity_id);

-- Audit records are append-only: block any attempt to change or remove them,
-- including from application code.
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs are append-only');
END;
`;

/** Open (and if needed create) the database, applying the schema. */
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDatabase, SCHEMA };
