'use strict';

const crypto = require('crypto');

/**
 * Password hashing with scrypt (from Node's own crypto module - no external
 * service, no paid account). A random salt per password, a fixed-length hash and
 * a timing-safe comparison on the way back.
 *
 * Stored format: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 */

const DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 64 };

function parameters(options = {}) {
  return {
    N: options.N || Number(process.env.SCRYPT_N || DEFAULTS.N),
    r: options.r || DEFAULTS.r,
    p: options.p || DEFAULTS.p,
  };
}

function hashPassword(password, options = {}) {
  const { N, r, p } = parameters(options);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, DEFAULTS.keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** Spend the same effort when the account does not exist (no timing leak). */
function burnPasswordCheck() {
  try {
    const { N, r, p } = parameters();
    crypto.scryptSync('not-a-real-password', crypto.randomBytes(16), DEFAULTS.keylen, { N, r, p });
  } catch {
    /* ignore */
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { hashPassword, verifyPassword, burnPasswordCheck, randomToken, sha256 };
