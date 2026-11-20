'use strict';

const path = require('path');
const express = require('express');
const { config } = require('./lib/env');
const { openDatabase } = require('./db');
const { ApiError, notFound } = require('./lib/errors');
const {
  createSessionStore,
  sessionMiddleware,
  csrfProtection,
  createRateLimiter,
  createSigninGuard,
} = require('./auth');
const { createLeaveService } = require('./services/leave');
const { ensureUploadDir } = require('./lib/uploads');

const authRoutes = require('./routes/auth');
const requestRoutes = require('./routes/requests');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');

function createApp(options = {}) {
  const db = options.db || openDatabase(options.dbPath || config.dbPath);
  ensureUploadDir();

  const sessions = createSessionStore(db);
  const signinGuard = createSigninGuard(db);
  const leave = createLeaveService(db);
  const ctx = { db, sessions, signinGuard, leave, config };

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');

  // --- security headers on every response -----------------------------------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(
    express.static(publicDir, {
      index: 'index.html',
      dotfiles: 'ignore',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // ---------------------------------------------------------------- API layer
  const api = express.Router();
  api.use(createRateLimiter({ windowMs: 60_000, max: 600 }));
  api.use(sessionMiddleware(db, sessions));
  api.use(csrfProtection);

  api.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  api.use('/auth', authRoutes(ctx));
  api.use('/', requestRoutes(ctx));
  api.use('/', notificationRoutes(ctx));
  api.use('/', adminRoutes(ctx));
  api.use((req, res, next) => next(notFound('That API endpoint does not exist.')));

  app.use('/api', api);

  // Anything else that is not an API call gets the single-page app.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next(notFound('That API endpoint does not exist.'));
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // ------------------------------------------------------------ error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      const payload = { error: { code: err.code, message: err.message } };
      if (err.details) payload.error.details = err.details;
      return res.status(err.status).json(payload);
    }
    if (err && err.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json({ error: { code: 'bad_request', message: 'The request body is not valid JSON.' } });
    }
    if (err && err.type === 'entity.too.large') {
      return res
        .status(413)
        .json({ error: { code: 'payload_too_large', message: 'That request is too large.' } });
    }
    // Never leak a stack trace to the browser; log it on the server only.
    console.error('[error]', err && err.stack ? err.stack : err);
    return res.status(500).json({
      error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' },
    });
  });

  return { app, db, ctx };
}

module.exports = { createApp };
