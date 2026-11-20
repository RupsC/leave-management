'use strict';

const express = require('express');
const { validate } = require('../lib/validate');
const {
  badRequest,
  conflict,
  tooManyRequests,
  unauthorized,
  validationFailed,
} = require('../lib/errors');
const { hashPassword } = require('../lib/password');
const { writeAudit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { clientIp, setSessionCookie, clearSessionCookie } = require('../auth');

function passwordProblems(password) {
  const errors = [];
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password.length > 128) errors.push('Password must be 128 characters or fewer.');
  if (!/[A-Za-z]/.test(password)) errors.push('Password must include at least one letter.');
  if (!/\d/.test(password)) errors.push('Password must include at least one number.');
  return errors;
}

function publicUser(db, user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    managerId: user.manager_id ?? null,
    department: user.department || null,
    unreadCount: db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(user.id).n,
  };
}

module.exports = function authRoutes(ctx) {
  const { db, sessions, signinGuard, config } = ctx;
  const router = express.Router();

  router.post('/signup', (req, res, next) => {
    try {
      const { value, errors } = validate(req.body, {
        name: { type: 'string', required: true, min: 2, max: 80, label: 'Full name' },
        email: { type: 'email', required: true, max: 160, label: 'E-mail' },
        password: { type: 'string', required: true, min: 8, max: 128, label: 'Password' },
        department: { type: 'string', max: 80, label: 'Department' },
      });
      if (value.password) {
        for (const message of passwordProblems(value.password)) {
          errors.push({ field: 'password', message });
        }
      }
      if (errors.length) throw validationFailed(errors);

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(value.email);
      if (existing) throw conflict('An account with that e-mail already exists.');

      // Public sign-up always creates an Employee. Manager and Admin accounts
      // are created by an Admin, so nobody can grant themselves extra rights.
      const manager = db
        .prepare("SELECT id FROM users WHERE role = 'manager' AND is_active = 1 ORDER BY id LIMIT 1")
        .get();

      const result = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO users (name, email, password_hash, role, manager_id, department)
             VALUES (?, ?, ?, 'employee', ?, ?)`,
          )
          .run(
            value.name,
            value.email,
            hashPassword(value.password),
            manager ? manager.id : null,
            value.department || null,
          );
        const userId = Number(info.lastInsertRowid);

        const leaveTypes = db
          .prepare('SELECT id, default_days FROM leave_types WHERE is_active = 1')
          .all();
        const insertBalance = db.prepare(
          `INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(user_id, leave_type_id, year) DO NOTHING`,
        );
        const year = new Date().getFullYear();
        for (const type of leaveTypes) insertBalance.run(userId, type.id, year, type.default_days);

        return userId;
      })();

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result);

      writeAudit(db, {
        actorId: user.id,
        action: 'user.create',
        entityType: 'user',
        entityId: user.id,
        after: { name: user.name, email: user.email, role: user.role, managerId: user.manager_id },
        note: 'Self sign-up',
        ip: clientIp(req),
      });

      if (user.manager_id) {
        notify(db, {
          userId: user.manager_id,
          type: 'user_created',
          title: 'New team member',
          body: `${user.name} has created an account and is now in your team.`,
        });
      }

      const session = sessions.create(user.id, clientIp(req));
      setSessionCookie(res, session.token);
      res.status(201).json({ user: publicUser(db, user), csrfToken: session.csrfToken });
    } catch (err) {
      next(err);
    }
  });

  router.post('/signin', (req, res, next) => {
    try {
      const { value, errors } = validate(req.body, {
        email: { type: 'email', required: true, label: 'E-mail' },
        password: { type: 'string', required: true, max: 128, label: 'Password' },
      });
      if (errors.length) throw validationFailed(errors);

      if (signinGuard.isLockedOut(value.email)) {
        throw tooManyRequests(
          `Too many failed sign-in attempts. Please wait ${config.signinWindowMinutes} minutes and try again.`,
        );
      }

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(value.email);
      const ok = signinGuard.verify(user, value.password);
      if (!ok || !user.is_active) {
        signinGuard.recordFailure(value.email, clientIp(req));
        throw unauthorized('E-mail or password is not correct.');
      }

      signinGuard.recordSuccess(value.email, clientIp(req));
      const session = sessions.create(user.id, clientIp(req));
      setSessionCookie(res, session.token);
      writeAudit(db, {
        actorId: user.id,
        action: 'auth.signin',
        entityType: 'user',
        entityId: user.id,
        ip: clientIp(req),
      });
      res.json({ user: publicUser(db, user), csrfToken: session.csrfToken });
    } catch (err) {
      next(err);
    }
  });

  router.post('/signout', (req, res, next) => {
    try {
      if (req.user) {
        writeAudit(db, {
          actorId: req.user.id,
          action: 'auth.signout',
          entityType: 'user',
          entityId: req.user.id,
          ip: clientIp(req),
        });
        sessions.destroy(req.sessionToken);
      }
      clearSessionCookie(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', (req, res, next) => {
    try {
      if (!req.user) throw unauthorized();
      res.json({ user: publicUser(db, req.user), csrfToken: req.csrfToken });
    } catch (err) {
      next(err);
    }
  });

  router.post('/password', (req, res, next) => {
    try {
      if (!req.user) throw unauthorized();
      const { value, errors } = validate(req.body, {
        currentPassword: { type: 'string', required: true, max: 128, label: 'Current password' },
        newPassword: { type: 'string', required: true, min: 8, max: 128, label: 'New password' },
      });
      if (value.newPassword) {
        for (const message of passwordProblems(value.newPassword)) {
          errors.push({ field: 'newPassword', message });
        }
      }
      if (errors.length) throw validationFailed(errors);

      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!signinGuard.verify(row, value.currentPassword)) {
        throw badRequest('Your current password is not correct.');
      }
      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        hashPassword(value.newPassword),
        new Date().toISOString(),
        req.user.id,
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(req.user.id, req.session.id);
      writeAudit(db, {
        actorId: req.user.id,
        action: 'user.password_change',
        entityType: 'user',
        entityId: req.user.id,
        ip: clientIp(req),
      });
      res.json({ ok: true, message: 'Your password has been changed.' });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
