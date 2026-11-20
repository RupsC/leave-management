'use strict';

/**
 * In-app notifications only. Rupali asked for no Google tools, so nothing is
 * ever e-mailed or pushed to a calendar service - notifications live in the
 * notifications table, are shown on the notifications page and counted in the
 * unread badge.
 */
function notify(db, { userId, type, title, body, leaveRequestId = null }) {
  if (!userId) return;
  db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, leave_request_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, type, title, body, leaveRequestId);
}

/** Notify every active admin (used when a request has no manager to go to). */
function notifyAdmins(db, payload) {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all();
  for (const admin of admins) notify(db, { ...payload, userId: admin.id });
  return admins.length;
}

module.exports = { notify, notifyAdmins };
