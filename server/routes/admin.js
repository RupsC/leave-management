'use strict';

const express = require('express');
const { validate, parseId } = require('../lib/validate');
const { badRequest, conflict, forbidden, notFound, validationFailed } = require('../lib/errors');
const { hashPassword } = require('../lib/password');
const { writeAudit } = require('../lib/audit');
const { requireAuth, requireRole, clientIp } = require('../auth');

const USER_COLUMNS = `id, name, email, role, manager_id AS managerId, department,
                      is_active AS isActive, created_at AS createdAt`;

module.exports = function adminRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  router.use(requireAuth);

  // People directory: admins see everyone, managers see their team.
  router.get('/users', (req, res, next) => {
    try {
      let rows;
      if (req.user.role === 'admin') {
        rows = db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY role DESC, name`).all();
      } else if (req.user.role === 'manager') {
        rows = db
          .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE manager_id = ? OR id = ? ORDER BY name`)
          .all(req.user.id, req.user.id);
      } else {
        rows = db
          .prepare(
            `SELECT u.id, u.name, u.role, u.department FROM users u
             WHERE u.id = ? OR u.manager_id = (SELECT manager_id FROM users WHERE id = ?)
             ORDER BY u.name`,
          )
          .all(req.user.id, req.user.id);
      }
      res.json({
        users: rows.map((row) => ({
          ...row,
          isActive: row.isActive === undefined ? true : Boolean(row.isActive),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Admin creates Manager and Admin accounts (employees can also self sign-up).
  router.post('/users', requireRole('admin'), (req, res, next) => {
    try {
      const { value, errors } = validate(req.body, {
        name: { type: 'string', required: true, min: 2, max: 80, label: 'Full name' },
        email: { type: 'email', required: true, max: 160, label: 'E-mail' },
        password: { type: 'string', required: true, min: 8, max: 128, label: 'Password' },
        role: { type: 'enum', required: true, values: ['admin', 'manager', 'employee'], label: 'Role' },
        department: { type: 'string', max: 80, label: 'Department' },
        managerId: { type: 'integer', min: 1, label: 'Manager' },
      });
      if (value.password && !/[A-Za-z]/.test(value.password)) {
        errors.push({ field: 'password', message: 'Password must include at least one letter.' });
      }
      if (value.password && !/\d/.test(value.password)) {
        errors.push({ field: 'password', message: 'Password must include at least one number.' });
      }
      if (value.managerId) {
        const manager = db
          .prepare("SELECT id FROM users WHERE id = ? AND role IN ('manager', 'admin')")
          .get(value.managerId);
        if (!manager) errors.push({ field: 'managerId', message: 'Choose a valid manager.' });
      }
      if (errors.length) throw validationFailed(errors);

      if (db.prepare('SELECT id FROM users WHERE email = ?').get(value.email)) {
        throw conflict('An account with that e-mail already exists.');
      }

      const userId = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO users (name, email, password_hash, role, manager_id, department)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            value.name,
            value.email,
            hashPassword(value.password),
            value.role,
            value.managerId || null,
            value.department || null,
          );
        const newId = Number(info.lastInsertRowid);
        db.prepare(
          `INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days)
           SELECT ?, id, ?, default_days, 0 FROM leave_types WHERE is_active = 1
           ON CONFLICT(user_id, leave_type_id, year) DO NOTHING`,
        ).run(newId, new Date().getFullYear());
        return newId;
      })();

      const user = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId);
      writeAudit(db, {
        actorId: req.user.id,
        action: 'user.create',
        entityType: 'user',
        entityId: userId,
        after: { name: user.name, email: user.email, role: user.role, managerId: user.managerId },
        note: 'Created by admin',
        ip: clientIp(req),
      });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/users/:id', requireRole('admin'), (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That user id is not valid.');
      const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!existing) throw notFound('That user does not exist.');

      const { value, errors } = validate(req.body, {
        role: { type: 'enum', values: ['admin', 'manager', 'employee'], label: 'Role' },
        managerId: { type: 'integer', min: 1, label: 'Manager' },
        department: { type: 'string', max: 80, label: 'Department' },
        isActive: { type: 'enum', values: ['true', 'false', 'true', 'false', 1, 0, true, false], label: 'Active' },
      });
      if (errors.length) throw validationFailed(errors);
      if (value.managerId === id) throw badRequest('A person cannot be their own manager.');
      if (value.role && value.role !== 'admin' && id === req.user.id) {
        throw forbidden('You cannot remove your own admin role.');
      }

      const isActiveNext =
        value.isActive === undefined
          ? Boolean(existing.is_active)
          : value.isActive === 'true' || value.isActive === true || value.isActive === 1;

      const before = {
        role: existing.role,
        managerId: existing.manager_id,
        department: existing.department,
        isActive: Boolean(existing.is_active),
      };
      const after = {
        role: value.role || existing.role,
        managerId: value.managerId || existing.manager_id,
        department: value.department === undefined ? existing.department : value.department,
        isActive: isActiveNext,
      };

      db.prepare(
        `UPDATE users SET role = ?, manager_id = ?, department = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        after.role,
        after.managerId,
        after.department,
        after.isActive ? 1 : 0,
        new Date().toISOString(),
        id,
      );

      writeAudit(db, {
        actorId: req.user.id,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        before,
        after,
        ip: clientIp(req),
      });

      res.json({ user: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------- audit logs
  router.get('/audit-logs', requireRole('admin'), (req, res, next) => {
    try {
      const where = [];
      const params = [];
      if (req.query.action) {
        where.push('a.action = ?');
        params.push(String(req.query.action));
      }
      if (req.query.actorId) {
        const actorId = parseId(req.query.actorId);
        if (!actorId) throw badRequest('That user id is not valid.');
        where.push('a.actor_id = ?');
        params.push(actorId);
      }
      if (req.query.entityType) {
        where.push('a.entity_type = ?');
        params.push(String(req.query.entityType));
      }
      if (req.query.entityId) {
        const entityId = parseId(req.query.entityId);
        if (!entityId) throw badRequest('That entity id is not valid.');
        where.push('a.entity_id = ?');
        params.push(entityId);
      }
      if (req.query.from) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.from)) throw badRequest('"from" must be a date.');
        where.push('a.created_at >= ?');
        params.push(`${req.query.from}T00:00:00.000Z`);
      }
      if (req.query.to) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) throw badRequest('"to" must be a date.');
        where.push('a.created_at <= ?');
        params.push(`${req.query.to}T23:59:59.999Z`);
      }

      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(
          `SELECT a.id, a.action, a.entity_type AS entityType, a.entity_id AS entityId,
                  a.before_json AS beforeJson, a.after_json AS afterJson, a.note, a.ip,
                  a.created_at AS createdAt, a.actor_id AS actorId, u.name AS actorName
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_id
           ${clause}
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT ?`,
        )
        .all(...params, limit);

      const actions = db
        .prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action')
        .all()
        .map((row) => row.action);

      res.json({
        logs: rows.map((row) => ({
          ...row,
          before: row.beforeJson ? JSON.parse(row.beforeJson) : null,
          after: row.afterJson ? JSON.parse(row.afterJson) : null,
        })),
        actions,
        count: rows.length,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
