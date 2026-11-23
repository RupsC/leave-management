'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..', '..');

// .env is optional: the app runs with sensible defaults, and .env is git-ignored.
try {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.join(projectRoot, '.env') });
} catch {
  /* dotenv is optional at runtime */
}

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, 'data');

/**
 * The session secret never lives in the repository. It comes from the
 * environment when it is set, otherwise a random one is generated once and kept
 * in the (git-ignored) data folder so sessions survive a restart.
 */
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(dataDir, '.session-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* not created yet */
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const nodeEnv = process.env.NODE_ENV || 'development';

const config = {
  projectRoot,
  dataDir,
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'leave.db'),
  uploadDir: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(dataDir, 'uploads'),
  sessionSecret: resolveSessionSecret(),
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 12),
  signinMaxFailures: int(process.env.SIGNIN_MAX_FAILURES, 5),
  signinWindowMinutes: int(process.env.SIGNIN_WINDOW_MINUTES, 15),
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 5),
  maxLeaveSpanDays: int(process.env.MAX_LEAVE_SPAN_DAYS, 120),
};

module.exports = { config, projectRoot };
