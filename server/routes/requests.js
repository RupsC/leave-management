'use strict';

const express = require('express');
const fs = require('fs');
const { validate, parseId, checkDateRange } = require('../lib/validate');
const { badRequest, forbidden, notFound, validationFailed } = require('../lib/errors');
const { isValidMonth, monthBounds, todayIso, eachDate } = require('../lib/dates');
const { requireAuth, requireRole, clientIp } = require('../auth');
const { handleUpload, saveAttachment, discardAttachment, storedPath } = require('../lib/uploads');

module.exports = function requestRoutes(ctx) {
  const { db, leave } = ctx;
  const router = express.Router();

  router.use(requireAuth);

  // ---------------------------------------------------------------- leave types
  router.get('/leave-types', (req, res) => {
    res.json({
      leaveTypes: db
        .prepare(
          'SELECT id, name, code, color, default_days AS defaultDays, requires_document AS requiresDocument FROM leave_types WHERE is_active = 1 ORDER BY name',
        )
        .all(),
    });
  });

  // ------------------------------------------------------------------- balances
  router.get('/balances', (req, res, next) => {
    try {
      const year = req.query.year ? Number(req.query.year) : Number(todayIso().slice(0, 4));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw badRequest('Year must be a four-digit year between 2000 and 2100.');
      }
      let userId = req.user.id;
      if (req.query.userId !== undefined) {
        const requested = parseId(req.query.userId);
        if (!requested) throw badRequest('That user id is not valid.');
        if (requested !== req.user.id) {
          if (req.user.role === 'employee') {
            throw forbidden('You can only see your own leave balance.');
          }
          if (req.user.role === 'manager') {
            const target = db.prepare('SELECT * FROM users WHERE id = ?').get(requested);
            if (!target || target.manager_id !== req.user.id) {
              throw forbidden('That employee is not in your team.');
            }
          }
        }
        userId = requested;
      }
      res.json({ userId, year, balances: leave.balancesForUser(userId, year) });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------ dashboard
  router.get('/dashboard', (req, res, next) => {
    try {
      const year = req.query.year ? Number(req.query.year) : undefined;
      if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
        throw badRequest('Year must be a four-digit year between 2000 and 2100.');
      }
      res.json(leave.dashboard(req.user, year));
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------- leave requests
  router.post('/leave-requests', handleUpload, (req, res, next) => {
    let saved = null;
    try {
      const { value, errors } = validate(req.body, {
        leaveTypeId: { type: 'integer', required: true, min: 1, label: 'Leave type' },
        startDate: { type: 'date', required: true, notBefore: '2000-01-01', label: 'Start date' },
        endDate: { type: 'date', required: true, notBefore: '2000-01-01', label: 'End date' },
        halfDay: { type: 'enum', values: ['none', 'am', 'pm'], default: 'none', label: 'Half day' },
        reason: { type: 'string', required: true, min: 10, max: 500, label: 'Reason' },
      });
      errors.push(...checkDateRange(value.startDate, value.endDate));
      if (errors.length) throw validationFailed(errors);

      if (req.file) {
        saved = saveAttachment(req.file);
      }

      const result = leave.createRequest({
        user: req.user,
        leaveTypeId: value.leaveTypeId,
        startDate: value.startDate,
        endDate: value.endDate,
        halfDay: value.halfDay || 'none',
        reason: value.reason,
        attachment: saved,
        ip: clientIp(req),
      });

      res.status(201).json({
        request: result.request,
        workingDays: result.days,
        conflicts: result.conflicts,
        balance: leave.balancesForUser(req.user.id, result.year),
      });
    } catch (err) {
      if (saved) discardAttachment(saved.storedName);
      next(err);
    }
  });

  router.get('/leave-requests', (req, res, next) => {
    try {
      const filters = {
        scope: typeof req.query.scope === 'string' ? req.query.scope : 'mine',
        status: req.query.status,
        userId: req.query.userId ? parseId(req.query.userId) : undefined,
        leaveTypeId: req.query.leaveTypeId ? parseId(req.query.leaveTypeId) : undefined,
        from: req.query.from,
        to: req.query.to,
      };
      if (filters.status && !['pending', 'approved', 'rejected', 'cancelled'].includes(filters.status)) {
        throw badRequest('Status filter must be pending, approved, rejected or cancelled.');
      }
      if (req.query.userId && !filters.userId) throw badRequest('That user id is not valid.');
      if (req.query.leaveTypeId && !filters.leaveTypeId) throw badRequest('That leave type id is not valid.');
      if (filters.from && !/^\d{4}-\d{2}-\d{2}$/.test(filters.from)) {
        throw badRequest('The "from" filter must be a date (YYYY-MM-DD).');
      }
      if (filters.to && !/^\d{4}-\d{2}-\d{2}$/.test(filters.to)) {
        throw badRequest('The "to" filter must be a date (YYYY-MM-DD).');
      }
      if (!['mine', 'team', 'all'].includes(filters.scope)) {
        throw badRequest('Scope must be mine, team or all.');
      }
      if (filters.scope !== 'mine' && req.user.role === 'employee') {
        throw forbidden('You can only see your own leave requests.');
      }
      const rows = leave.listRequests(req.user, filters);
      res.json({ requests: rows, count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  router.get('/leave-requests/:id', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That request id is not valid.');
      const request = leave.getRequestFor(req.user, id);
      res.json({ request, attachments: leave.attachmentsFor(id) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/leave-requests/:id/cancel', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That request id is not valid.');
      const result = leave.cancel({ requestId: id, actor: req.user, ip: clientIp(req) });
      res.json({
        request: result.request,
        balance: result.balance,
        balances: leave.balancesForUser(req.user.id, Number(result.request.startDate.slice(0, 4))),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/leave-requests/:id/reverse', requireRole('admin'), (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That request id is not valid.');
      const result = leave.cancel({ requestId: id, actor: req.user, ip: clientIp(req), asAdmin: true });
      res.json({ request: result.request, balance: result.balance });
    } catch (err) {
      next(err);
    }
  });

  router.post('/leave-requests/:id/decision', requireRole('manager', 'admin'), (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That request id is not valid.');
      const { value, errors } = validate(req.body, {
        action: { type: 'enum', required: true, values: ['approve', 'reject'], label: 'Decision' },
        comment: { type: 'string', max: 500, label: 'Comment' },
      });
      if (errors.length) throw validationFailed(errors);
      if (value.action === 'reject' && !value.comment) {
        throw validationFailed([
          { field: 'comment', message: 'A rejection reason is required.' },
        ]);
      }
      const result = leave.decide({
        requestId: id,
        actor: req.user,
        action: value.action,
        comment: value.comment,
        ip: clientIp(req),
      });
      res.json({ request: result.request, balance: result.balance });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------ documents
  router.get('/leave-requests/:id/attachments', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That request id is not valid.');
      leave.getRequestFor(req.user, id); // authorisation check
      res.json({ attachments: leave.attachmentsFor(id) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/leave-requests/:id/attachment', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) throw badRequest('That request id is not valid.');
      const attachmentId = req.query.attachmentId ? parseId(req.query.attachmentId) : null;
      if (req.query.attachmentId && !attachmentId) throw badRequest('That document id is not valid.');
      const attachment = leave.requestAttachmentFor(req.user, id, attachmentId);
      const fullPath = storedPath(attachment.stored_name);
      if (!fs.existsSync(fullPath)) throw notFound('That document is no longer stored on the server.');

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="${attachment.original_name.replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.sendFile(fullPath);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------- calendar
  router.get('/calendar', (req, res, next) => {
    try {
      const month = req.query.month || todayIso().slice(0, 7);
      if (!isValidMonth(month)) throw badRequest('Month must look like 2026-11.');
      const { start, end } = monthBounds(month);
      const scope = req.user.role === 'employee' ? leave.teamUserIds(req.user) : leave.teamUserIds(req.user);
      const data = leave.calendar(start, end, scope);
      res.json({ month, startsOn: start, endsOn: end, ...data, daysInMonth: eachDate(start, end) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/overlaps', (req, res, next) => {
    try {
      const start = req.query.startDate;
      const end = req.query.endDate || start;
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
        throw badRequest('Give startDate and endDate as YYYY-MM-DD.');
      }
      if (end < start) throw badRequest('End date cannot be before the start date.');
      const conflicts = leave.findConflicts(start, end, { excludeUserId: req.user.id });
      res.json({ startDate: start, endDate: end, hasOverlap: conflicts.length > 0, conflicts });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
