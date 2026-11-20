'use strict';

const { ApiError, badRequest, conflict, forbidden, notFound, validationFailed } = require('../lib/errors');
const { countLeaveDays, countWorkingDays, eachDate, isWeekend, nowIso, todayIso } = require('../lib/dates');
const { writeAudit } = require('../lib/audit');
const { notify, notifyAdmins } = require('../lib/notify');

const REQUEST_SELECT = `
  SELECT r.id,
         r.user_id          AS userId,
         u.name             AS employeeName,
         u.email            AS employeeEmail,
         r.leave_type_id    AS leaveTypeId,
         lt.name            AS leaveType,
         lt.color           AS leaveTypeColor,
         r.start_date       AS startDate,
         r.end_date         AS endDate,
         r.half_day         AS halfDay,
         r.working_days     AS workingDays,
         r.reason           AS reason,
         r.status           AS status,
         r.decided_by       AS decidedBy,
         d.name             AS decidedByName,
         r.decision_comment AS decisionComment,
         r.decided_at       AS decidedAt,
         r.created_at       AS createdAt,
         r.updated_at       AS updatedAt,
         (SELECT COUNT(*) FROM attachments a WHERE a.leave_request_id = r.id) AS attachmentCount
  FROM leave_requests r
  JOIN users u        ON u.id = r.user_id
  JOIN leave_types lt ON lt.id = r.leave_type_id
  LEFT JOIN users d   ON d.id = r.decided_by
`;

function createLeaveService(db) {
  const getRequestRow = db.prepare('SELECT * FROM leave_requests WHERE id = ?');
  const getUserRow = db.prepare('SELECT * FROM users WHERE id = ?');
  const requestSelect = db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`);

  const requestById = (id) => {
    const row = requestSelect.get(id);
    return row ? { ...row, workingDays: Number(row.workingDays) } : null;
  };

  function getLeaveType(id) {
    return db.prepare('SELECT * FROM leave_types WHERE id = ? AND is_active = 1').get(id);
  }

  function ensureBalance(userId, leaveTypeId, year) {
    const existing = db
      .prepare('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?')
      .get(userId, leaveTypeId, year);
    if (existing) return existing;
    const type = db.prepare('SELECT default_days FROM leave_types WHERE id = ?').get(leaveTypeId);
    db.prepare(
      `INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(user_id, leave_type_id, year) DO NOTHING`,
    ).run(userId, leaveTypeId, year, type ? type.default_days : 0);
    return db
      .prepare('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?')
      .get(userId, leaveTypeId, year);
  }

  function balancesForUser(userId, year) {
    const rows = db
      .prepare(
        `SELECT lt.id            AS leaveTypeId,
                lt.name          AS leaveType,
                lt.code          AS code,
                lt.color         AS color,
                COALESCE(lb.entitled_days, 0) AS entitledDays,
                COALESCE(lb.used_days, 0)     AS usedDays
         FROM leave_types lt
         LEFT JOIN leave_balances lb
                ON lb.leave_type_id = lt.id AND lb.user_id = ? AND lb.year = ?
         WHERE lt.is_active = 1
         ORDER BY lt.name`,
      )
      .all(userId, year);
    return rows.map((row) => {
      const entitledDays = Number(row.entitledDays);
      const usedDays = Number(row.usedDays);
      return {
        ...row,
        entitledDays,
        usedDays,
        remainingDays: Number((entitledDays - usedDays).toFixed(2)),
      };
    });
  }

  function remainingFor(userId, leaveTypeId, year) {
    const balance = balancesForUser(userId, year).find((b) => b.leaveTypeId === leaveTypeId);
    return balance ? balance.remainingDays : 0;
  }

  /** Other people's pending/approved leave that overlaps the given dates. */
  function findConflicts(startDate, endDate, { excludeUserId = null, excludeRequestId = null } = {}) {
    const rows = db
      .prepare(
        `SELECT r.id, r.user_id AS userId, u.name AS userName, r.start_date AS startDate,
                r.end_date AS endDate, r.status, lt.name AS leaveType, lt.color AS color
         FROM leave_requests r
         JOIN users u ON u.id = r.user_id
         JOIN leave_types lt ON lt.id = r.leave_type_id
         WHERE r.status IN ('pending', 'approved')
           AND r.start_date <= ?
           AND r.end_date   >= ?
           AND (? IS NULL OR r.user_id <> ?)
           AND (? IS NULL OR r.id <> ?)
         ORDER BY r.start_date, u.name`,
      )
      .all(startDate, endDate, excludeUserId, excludeUserId, excludeRequestId, excludeRequestId);

    return rows.map((row) => {
      const from = row.startDate > startDate ? row.startDate : startDate;
      const to = row.endDate < endDate ? row.endDate : endDate;
      return {
        requestId: row.id,
        userId: row.userId,
        userName: row.userName,
        leaveType: row.leaveType,
        color: row.color,
        status: row.status,
        startDate: row.startDate,
        endDate: row.endDate,
        overlappingDates: eachDate(from, to),
      };
    });
  }

  /** The manager an employee's request should be sent to. */
  function managerOf(user) {
    if (!user || !user.manager_id) return null;
    const manager = getUserRow.get(user.manager_id);
    return manager && manager.is_active ? manager : null;
  }

  function canActOnRequest(actor, request) {
    if (request.user_id === actor.id) return false; // never your own request
    if (actor.role === 'admin') return true;
    if (actor.role === 'manager') {
      const employee = getUserRow.get(request.user_id);
      return Boolean(employee && employee.manager_id === actor.id);
    }
    return false;
  }

  function canViewRequest(actor, request) {
    if (request.user_id === actor.id) return true;
    if (actor.role === 'admin') return true;
    if (actor.role === 'manager') {
      const employee = getUserRow.get(request.user_id);
      return Boolean(employee && employee.manager_id === actor.id);
    }
    return false;
  }

  function applyBalanceChange({ userId, leaveTypeId, year, delta, actorId, ip, reason }) {
    const before = ensureBalance(userId, leaveTypeId, year);
    const beforeSnapshot = {
      entitledDays: Number(before.entitled_days),
      usedDays: Number(before.used_days),
      remainingDays: Number((before.entitled_days - before.used_days).toFixed(2)),
    };
    const usedAfter = Number((before.used_days + delta).toFixed(2));
    if (usedAfter < 0) {
      throw conflict('That leave has already been returned to the balance.');
    }
    if (usedAfter > Number(before.entitled_days)) {
      throw new ApiError(422, 'insufficient_balance', 'This request would take the leave balance below zero.', {
        leaveTypeId,
        year,
        remainingDays: beforeSnapshot.remainingDays,
      });
    }
    db.prepare(
      `UPDATE leave_balances
          SET used_days = ?, updated_at = ?
        WHERE user_id = ? AND leave_type_id = ? AND year = ?`,
    ).run(usedAfter, nowIso(), userId, leaveTypeId, year);

    const afterSnapshot = {
      entitledDays: beforeSnapshot.entitledDays,
      usedDays: usedAfter,
      remainingDays: Number((beforeSnapshot.entitledDays - usedAfter).toFixed(2)),
    };

    writeAudit(db, {
      actorId,
      action: 'balance.change',
      entityType: 'leave_balance',
      entityId: before.id,
      before: beforeSnapshot,
      after: afterSnapshot,
      note: reason,
      ip,
    });

    notify(db, {
      userId,
      type: 'balance',
      title: 'Leave balance updated',
      body: `Your balance changed from ${beforeSnapshot.remainingDays} to ${afterSnapshot.remainingDays} day(s) remaining. ${reason}`,
    });

    return afterSnapshot;
  }

  function validateDates({ startDate, endDate, halfDay }) {
    if (endDate < startDate) throw badRequest('End date cannot be before the start date.');
    if (halfDay !== 'none') {
      if (startDate !== endDate) {
        throw badRequest('A half day can only be applied to a single-day request.');
      }
      if (isWeekend(startDate)) {
        throw badRequest('A half day cannot be taken on a weekend.');
      }
    }
  }

  function createRequest({ user, leaveTypeId, startDate, endDate, halfDay = 'none', reason, attachment, ip }) {
    const leaveType = getLeaveType(leaveTypeId);
    if (!leaveType) throw badRequest('Choose a valid leave type.');
    validateDates({ startDate, endDate, halfDay });

    const days = countLeaveDays(startDate, endDate, halfDay);
    if (days <= 0) {
      // Field-level refusal: the dates are the problem, so the form can point at them.
      throw validationFailed([
        { field: 'startDate', message: 'Those dates contain no working days.' },
        { field: 'endDate', message: 'Weekends are not counted as leave days, so pick at least one weekday.' },
      ]);
    }

    const year = Number(startDate.slice(0, 4));
    const remaining = remainingFor(user.id, leaveTypeId, year);
    if (days > remaining) {
      throw new ApiError(
        422,
        'insufficient_balance',
        `This request needs ${days} day(s) of ${leaveType.name} but only ${remaining} day(s) remain.`,
        { leaveTypeId, year, requestedDays: days, remainingDays: remaining },
      );
    }

    const conflicts = findConflicts(startDate, endDate, { excludeUserId: user.id });

    const requestId = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO leave_requests
             (user_id, leave_type_id, start_date, end_date, half_day, working_days, reason, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(user.id, leaveTypeId, startDate, endDate, halfDay, days, reason);
      const newId = Number(info.lastInsertRowid);

      db.prepare(
        `INSERT INTO decisions (leave_request_id, actor_id, action, comment) VALUES (?, ?, 'submit', ?)`,
      ).run(newId, user.id, reason);

      if (attachment) {
        db.prepare(
          `INSERT INTO attachments
             (leave_request_id, uploaded_by, original_name, stored_name, mime_type, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          newId,
          user.id,
          attachment.originalName,
          attachment.storedName,
          attachment.mimeType,
          attachment.sizeBytes,
        );
      }

      writeAudit(db, {
        actorId: user.id,
        action: 'request.create',
        entityType: 'leave_request',
        entityId: newId,
        after: {
          userId: user.id,
          leaveType: leaveType.name,
          startDate,
          endDate,
          halfDay,
          workingDays: days,
          status: 'pending',
        },
        note: reason,
        ip,
      });

      const manager = managerOf(getUserRow.get(user.id));
      const body = `${user.name} requested ${days} working day(s) of ${leaveType.name} from ${startDate} to ${endDate}.`;

      if (manager) {
        notify(db, {
          userId: manager.id,
          type: 'request_submitted',
          title: `New leave request from ${user.name}`,
          body: conflicts.length
            ? `${body} Note: ${conflicts.length} colleague(s) already have overlapping leave.`
            : body,
          leaveRequestId: newId,
        });
      } else {
        notifyAdmins(db, {
          type: 'request_submitted',
          title: `Leave request awaiting approval: ${user.name}`,
          body,
          leaveRequestId: newId,
        });
      }

      return newId;
    })();

    return { request: requestById(requestId), conflicts, days, year };
  }

  function decide({ requestId, actor, action, comment, ip }) {
    const request = getRequestRow.get(requestId);
    if (!request) throw notFound('That leave request does not exist.');
    if (request.user_id === actor.id) {
      throw forbidden('You cannot decide your own leave request.');
    }
    if (!canActOnRequest(actor, request)) {
      throw forbidden('You are not allowed to decide this request.');
    }
    if (action === 'reject' && (!comment || !comment.trim())) {
      throw badRequest('A rejection reason is required.');
    }
    if (request.status !== 'pending') {
      throw conflict(
        `This request has already been ${request.status}; it cannot be decided again.`,
        { status: request.status },
      );
    }

    const employee = getUserRow.get(request.user_id);
    const leaveType = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(request.leave_type_id);
    const days = Number(request.working_days);
    const year = Number(request.start_date.slice(0, 4));
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const balanceAfter = db.transaction(() => {
      const info = db
        .prepare(
          `UPDATE leave_requests
              SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(newStatus, actor.id, comment || null, nowIso(), nowIso(), requestId);

      // Two managers clicking at the same moment: only one UPDATE can win,
      // because it is conditional on the request still being pending.
      if (info.changes !== 1) {
        throw conflict('This request was already decided by someone else.');
      }

      db.prepare(
        'INSERT INTO decisions (leave_request_id, actor_id, action, comment) VALUES (?, ?, ?, ?)',
      ).run(requestId, actor.id, action, comment || null);

      let balance = null;
      if (action === 'approve') {
        balance = applyBalanceChange({
          userId: request.user_id,
          leaveTypeId: request.leave_type_id,
          year,
          delta: days,
          actorId: actor.id,
          ip,
          reason: `Approved ${days} day(s) of ${leaveType.name} (${request.start_date} to ${request.end_date}).`,
        });
      }

      writeAudit(db, {
        actorId: actor.id,
        action: action === 'approve' ? 'request.approve' : 'request.reject',
        entityType: 'leave_request',
        entityId: requestId,
        before: { status: 'pending' },
        after: { status: newStatus, decidedBy: actor.name, comment: comment || null, workingDays: days },
        note: comment || null,
        ip,
      });

      notify(db, {
        userId: request.user_id,
        type: action === 'approve' ? 'request_approved' : 'request_rejected',
        title: action === 'approve' ? 'Leave request approved' : 'Leave request rejected',
        body:
          action === 'approve'
            ? `Your ${leaveType.name} request for ${days} day(s) (${request.start_date} to ${request.end_date}) was approved by ${actor.name}.${balance ? ` Remaining balance: ${balance.remainingDays} day(s).` : ''}`
            : `Your ${leaveType.name} request for ${days} day(s) (${request.start_date} to ${request.end_date}) was rejected by ${actor.name}. Reason: ${comment}`,
        leaveRequestId: requestId,
      });

      return balance;
    })();

    return { request: requestById(requestId), balance: balanceAfter };
  }

  function cancel({ requestId, actor, ip, asAdmin = false }) {
    const request = getRequestRow.get(requestId);
    if (!request) throw notFound('That leave request does not exist.');

    if (asAdmin) {
      if (actor.role !== 'admin') throw forbidden('Only an admin can reverse an approved leave.');
      if (request.user_id === actor.id) {
        throw forbidden('Use the normal cancel action for your own leave.');
      }
      if (request.status !== 'approved') {
        throw conflict('Only an approved leave can be reversed.', { status: request.status });
      }
    } else {
      if (request.user_id !== actor.id) {
        throw forbidden('You can only cancel your own leave requests.');
      }
      if (request.status !== 'pending' && request.status !== 'approved') {
        throw conflict(`This request is already ${request.status}.`, { status: request.status });
      }
    }

    const wasApproved = request.status === 'approved';
    const days = Number(request.working_days);
    const year = Number(request.start_date.slice(0, 4));
    const leaveType = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(request.leave_type_id);

    return db.transaction(() => {
      const allowedStatus = wasApproved ? 'approved' : 'pending';
      const info = db
        .prepare(
          `UPDATE leave_requests
              SET status = 'cancelled', updated_at = ?
            WHERE id = ? AND status = ?`,
        )
        .run(nowIso(), requestId, allowedStatus);
      if (info.changes !== 1) {
        throw conflict('This request was already decided or cancelled.');
      }

      db.prepare(
        'INSERT INTO decisions (leave_request_id, actor_id, action, comment) VALUES (?, ?, ?, ?)',
      ).run(
        requestId,
        actor.id,
        asAdmin ? 'reverse' : 'cancel',
        asAdmin ? 'Reversed by admin' : 'Cancelled by employee',
      );

      let balanceAfter = null;
      if (wasApproved) {
        balanceAfter = applyBalanceChange({
          userId: request.user_id,
          leaveTypeId: request.leave_type_id,
          year,
          delta: -days,
          actorId: actor.id,
          ip,
          reason: `${days} day(s) of ${leaveType.name} returned after the leave was cancelled.`,
        });
      }

      writeAudit(db, {
        actorId: actor.id,
        action: wasApproved ? 'request.reverse' : 'request.cancel',
        entityType: 'leave_request',
        entityId: requestId,
        before: { status: request.status },
        after: { status: 'cancelled', workingDays: days },
        ip,
      });

      const employee = getUserRow.get(request.user_id);

      if (!asAdmin) {
        const manager = managerOf(employee);
        const recipients = [];
        if (manager) recipients.push(manager.id);
        else {
          const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all();
          recipients.push(...admins.map((a) => a.id));
        }
        for (const recipientId of recipients) {
          notify(db, {
            userId: recipientId,
            type: 'request_cancelled',
            title: `${employee.name} cancelled a leave request`,
            body: `The ${leaveType.name} request from ${request.start_date} to ${request.end_date} was cancelled.`,
            leaveRequestId: requestId,
          });
        }
      } else {
        notify(db, {
          userId: request.user_id,
          type: 'request_reversed',
          title: 'Approved leave reversed by admin',
          body: `Your ${leaveType.name} leave from ${request.start_date} to ${request.end_date} was reversed by ${actor.name}. The ${days} day(s) have been returned to your balance.`,
          leaveRequestId: requestId,
        });
      }

      return { request: requestById(requestId), balance: balanceAfter };
    })();
  }

  function listRequests(actor, filters = {}) {
    const where = [];
    const params = [];

    let scope = filters.scope || 'mine';
    if (scope === 'all' && actor.role !== 'admin') scope = 'team';
    if (scope === 'team' && actor.role === 'employee') scope = 'mine';

    if (scope === 'mine') {
      where.push('r.user_id = ?');
      params.push(actor.id);
    } else if (scope === 'team' && actor.role !== 'admin') {
      where.push('(r.user_id = ? OR u.manager_id = ?)');
      params.push(actor.id, actor.id);
    }
    // scope 'team' for an admin, and scope 'all', mean: no user filter

    if (filters.status) {
      where.push('r.status = ?');
      params.push(filters.status);
    }
    if (filters.userId) {
      where.push('r.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.leaveTypeId) {
      where.push('r.leave_type_id = ?');
      params.push(filters.leaveTypeId);
    }
    if (filters.from) {
      where.push('r.end_date >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('r.start_date <= ?');
      params.push(filters.to);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(`${REQUEST_SELECT} ${clause} ORDER BY r.start_date DESC, r.id DESC LIMIT 500`)
      .all(...params);
    return rows.map((row) => ({ ...row, workingDays: Number(row.workingDays) }));
  }

  function getRequestFor(actor, requestId) {
    const request = getRequestRow.get(requestId);
    if (!request) throw notFound('That leave request does not exist.');
    if (!canViewRequest(actor, request)) {
      throw forbidden('You do not have access to this leave request.');
    }
    return requestById(requestId);
  }

  /** Pending requests the actor is allowed to act on right now. */
  function decideableFor(actor) {
    const scope = actor.role === 'admin' ? 'all' : 'team';
    return listRequests(actor, { scope, status: 'pending' }).filter((row) => row.userId !== actor.id);
  }

  function calendar(monthStart, monthEnd, scopeUserIds) {
    const params = [monthEnd, monthStart];
    let userClause = '';
    if (Array.isArray(scopeUserIds)) {
      if (scopeUserIds.length === 0) return { days: {}, overlaps: [] };
      userClause = `AND r.user_id IN (${scopeUserIds.map(() => '?').join(',')})`;
      params.push(...scopeUserIds);
    }
    const rows = db
      .prepare(
        `SELECT r.id, r.user_id AS userId, u.name AS employeeName, r.start_date AS startDate,
                r.end_date AS endDate, r.half_day AS halfDay, r.status, r.working_days AS workingDays,
                lt.name AS leaveType, lt.color AS color
         FROM leave_requests r
         JOIN users u ON u.id = r.user_id
         JOIN leave_types lt ON lt.id = r.leave_type_id
         WHERE r.status IN ('approved', 'pending')
           AND r.start_date <= ?
           AND r.end_date   >= ?
           ${userClause}
         ORDER BY r.start_date, u.name`,
      )
      .all(...params);

    const days = {};
    for (const row of rows) {
      if (row.status !== 'approved') continue; // the calendar shows approved leave only
      const from = row.startDate > monthStart ? row.startDate : monthStart;
      const to = row.endDate < monthEnd ? row.endDate : monthEnd;
      for (const date of eachDate(from, to)) {
        if (!days[date]) days[date] = [];
        days[date].push({
          requestId: row.id,
          userId: row.userId,
          employeeName: row.employeeName,
          leaveType: row.leaveType,
          color: row.color,
          halfDay: row.startDate === row.endDate ? row.halfDay : 'none',
          status: row.status,
        });
      }
    }

    // Overlap detection: two or more different people away on the same date.
    const byDate = new Map();
    for (const row of rows) {
      const from = row.startDate > monthStart ? row.startDate : monthStart;
      const to = row.endDate < monthEnd ? row.endDate : monthEnd;
      for (const date of eachDate(from, to)) {
        if (!byDate.has(date)) byDate.set(date, new Map());
        byDate.get(date).set(row.userId, {
          userId: row.userId,
          employeeName: row.employeeName,
          leaveType: row.leaveType,
          color: row.color,
          status: row.status,
          requestId: row.id,
        });
      }
    }
    const overlaps = Array.from(byDate.entries())
      .filter(([, people]) => people.size >= 2)
      .map(([date, people]) => ({ date, people: Array.from(people.values()) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { days, overlaps };
  }

  function teamUserIds(actor) {
    if (actor.role === 'admin') {
      return db.prepare('SELECT id FROM users WHERE is_active = 1').all().map((r) => r.id);
    }
    return db
      .prepare('SELECT id FROM users WHERE is_active = 1 AND (manager_id = ? OR id = ?)')
      .all(actor.id, actor.id)
      .map((r) => r.id);
  }

  function dashboard(actor, year) {
    const workingYear = year || Number(todayIso().slice(0, 4));
    const balances = balancesForUser(actor.id, workingYear);
    const mine = listRequests(actor, { scope: 'mine' });
    const today = todayIso();
    const pending = mine.filter((r) => r.status === 'pending');
    const approved = mine.filter((r) => r.status === 'approved');
    const upcoming = approved
      .filter((r) => r.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    const history = mine.filter((r) => r.status === 'rejected' || r.status === 'cancelled');

    const data = {
      year: workingYear,
      today,
      balances,
      pending,
      approved,
      upcoming,
      history,
      totals: {
        pending: pending.length,
        approved: approved.length,
        rejected: mine.filter((r) => r.status === 'rejected').length,
        cancelled: mine.filter((r) => r.status === 'cancelled').length,
      },
    };

    if (actor.role === 'manager' || actor.role === 'admin') {
      const teamRows = listRequests(actor, { scope: actor.role === 'admin' ? 'all' : 'team' });
      const teamPending = teamRows.filter((r) => r.status === 'pending' && r.userId !== actor.id);
      const teamApproved = teamRows.filter((r) => r.status === 'approved');
      data.team = {
        pending: teamPending,
        approved: teamApproved,
        pendingCount: teamPending.length,
        approvedCount: teamApproved.length,
        people: teamUserIds(actor).length,
      };
    }

    return data;
  }

  function unreadCount(userId) {
    return db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(userId).n;
  }

  function requestAttachmentFor(actor, requestId, attachmentId) {
    const request = getRequestRow.get(requestId);
    if (!request) throw notFound('That leave request does not exist.');
    if (!canViewRequest(actor, request)) {
      throw forbidden('You do not have access to this document.');
    }
    const attachment = attachmentId
      ? db
          .prepare('SELECT * FROM attachments WHERE id = ? AND leave_request_id = ?')
          .get(attachmentId, requestId)
      : db
          .prepare('SELECT * FROM attachments WHERE leave_request_id = ? ORDER BY id LIMIT 1')
          .get(requestId);
    if (!attachment) throw notFound('There is no document attached to this request.');
    return attachment;
  }

  function attachmentsFor(requestId) {
    return db
      .prepare(
        `SELECT id, original_name AS originalName, mime_type AS mimeType,
                size_bytes AS sizeBytes, created_at AS createdAt
         FROM attachments WHERE leave_request_id = ? ORDER BY id`,
      )
      .all(requestId);
  }

  return {
    balancesForUser,
    remainingFor,
    ensureBalance,
    findConflicts,
    createRequest,
    decide,
    cancel,
    listRequests,
    getRequestFor,
    decideableFor,
    calendar,
    teamUserIds,
    dashboard,
    unreadCount,
    requestAttachmentFor,
    attachmentsFor,
    canActOnRequest,
    canViewRequest,
    managerOf,
    requestById,
    countWorkingDays,
  };
}

module.exports = { createLeaveService, REQUEST_SELECT };
