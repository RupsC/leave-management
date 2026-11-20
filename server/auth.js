'use strict';

const crypto = require('crypto');
const { config } = require('./lib/env');
const { randomToken, sha256, burnPasswordCheck, verifyPassword } = require('./lib/password');
const { unauthorized, forbidden, tooManyRequests } = require('./lib/errors');
const { writeAudit } = require('./lib/audit');

const COOKIE_NAME = 'lms_session';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function cookieValueFor(token) {
  return `${token}.${sign(token)}`;
}

function tokenFromCookie(raw) {
  if (typeof raw !== 'string') return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const token = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = sign(token);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  return token;
}

function createSessionStore(db) {
  const insert = db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, ip, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const find = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const touch = db.prepare(
    "UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  );
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');
  const removeForUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');

  return {
    create(userId, ip) {
      const token = randomToken(32);
      const csrfToken = randomToken(24);
      const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
      insert.run(sha256(token), userId, csrfToken, ip || null, expiresAt);
      return { token, csrfToken, expiresAt };
    },
    get(token) {
      if (!token) return null;
      const row = find.get(sha256(token));
      if (!row) return null;
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        remove.run(row.id);
        return null;
      }
      if (Math.random() < 0.1) touch.run(row.id); // cheap "last seen" refresh
      return row;
    },
    destroy(token) {
      if (!token) return;
      remove.run(sha256(token));
    },
    destroyAllForUser(userId) {
      removeForUser.run(userId);
    },
  };
}

function setSessionCookie(res, token) {
  const maxAge = config.sessionTtlHours * 3600;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(cookieValueFor(token))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (config.isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clientIp(req) {
  return (req.ip || '').replace('::ffff:', '') || 'unknown';
}

/** Loads the signed-in user (if any) onto the request. */
function sessionMiddleware(db, sessions) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = tokenFromCookie(cookies[COOKIE_NAME]);
    req.sessionToken = token;
    req.user = null;
    req.session = null;
    if (!token) return next();

    const session = sessions.get(token);
    if (!session) {
      clearSessionCookie(res);
      return next();
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(session.user_id);
    if (!user) {
      sessions.destroy(token);
      clearSessionCookie(res);
      return next();
    }
    const { password_hash, ...safeUser } = user;
    req.user = safeUser;
    req.session = session;
    req.csrfToken = session.csrf_token;
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden('Your role does not allow that action.'));
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Sign-in and sign-up happen before there is a session, so there is no CSRF
// token to check yet. Both routes are still rate limited and validated.
const SESSIONLESS_POST_PATHS = new Set(['/api/auth/signin', '/api/auth/signup']);

/**
 * CSRF protection on every state-changing request. The token lives in the
 * session (server side) and must be sent back in the X-CSRF-Token header or a
 * _csrf body field, so another site cannot make the browser act for the user.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const routePath = String(req.originalUrl || req.url || '').split('?')[0];
  if (SESSIONLESS_POST_PATHS.has(routePath)) return next();
  if (!req.user || !req.session) return next(unauthorized());

  const supplied =
    req.get('x-csrf-token') ||
    (req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '') ||
    (req.query && typeof req.query._csrf === 'string' ? req.query._csrf : '');

  const expected = req.session.csrf_token || '';
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(forbidden('Your form session expired. Please refresh the page and try again.'));
  }
  next();
}

/** Very small in-memory rate limiter for the whole API. */
function createRateLimiter({ windowMs = 60_000, max = 400 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = clientIp(req);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(tooManyRequests('Too many requests. Please slow down and try again shortly.'));
    }
    next();
  };
}

/** Sign-in lockout: counts recent failures per e-mail address. */
function createSigninGuard(db) {
  const recentFailures = db.prepare(
    `SELECT COUNT(*) AS n FROM signin_attempts
      WHERE email = ? AND success = 0 AND created_at >= datetime('now', ?)`,
  );
  const record = db.prepare('INSERT INTO signin_attempts (email, ip, success) VALUES (?, ?, ?)');
  const clear = db.prepare('DELETE FROM signin_attempts WHERE email = ?');
  const windowModifier = `-${config.signinWindowMinutes} minutes`;

  return {
    isLockedOut(email) {
      return recentFailures.get(email, windowModifier).n >= config.signinMaxFailures;
    },
    recordFailure(email, ip) {
      record.run(email, ip || null, 0);
      writeAudit(db, { action: 'auth.signin_failed', entityType: 'user', note: email, ip });
    },
    recordSuccess(email, ip) {
      record.run(email, ip || null, 1);
      clear.run(email);
    },
    verify(user, password) {
      if (!user) {
        burnPasswordCheck();
        return false;
      }
      return verifyPassword(password, user.password_hash);
    },
  };
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  createSessionStore,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  requireAuth,
  requireRole,
  csrfProtection,
  createRateLimiter,
  createSigninGuard,
  clientIp,
};
