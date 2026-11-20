'use strict';

const express = require('express');
const { parseId } = require('../lib/validate');
const { badRequest, notFound } = require('../lib/errors');
const { requireAuth } = require('../auth');

module.exports = function notificationRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  router.use(requireAuth);

  router.get('/notifications', (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      const rows = db
        .prepare(
          `SELECT id, type, title, body, leave_request_id AS leaveRequestId,
                  is_read AS isRead, created_at AS createdAt
           FROM notifications
           WHERE user_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(req.user.id, limit);
      const unread = db
        .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
        .get(req.user.id).n;
      res.json({
        notifications: rows.map((row) => ({ ...row, isRead: Boolean(row.isRead) })),
        unreadCount: unread,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/notifications/unread-count', (req, res) => {
    const unread = db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(req.user.id).n;
    res.json({ unreadCount: unread });
  });

  router.post('/notifications/:id/read', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That notification id is not valid.');
      const info = db
        .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
        .run(id, req.user.id);
      if (info.changes === 0) throw notFound('That notification does not exist.');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/notifications/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
    res.json({ ok: true });
  });

  return router;
};
