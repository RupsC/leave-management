'use strict';

/**
 * Append-only audit trail. Every write goes through this helper so that the
 * "who / when / what changed / from what to what" information is consistent.
 * There is deliberately no update or delete function: the database itself
 * refuses changes to this table (see triggers in db.js).
 */
function writeAudit(db, entry) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before_json, after_json, note, ip)
    VALUES (@actorId, @action, @entityType, @entityId, @beforeJson, @afterJson, @note, @ip)
  `);
  stmt.run({
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
    afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    note: entry.note ?? null,
    ip: entry.ip ?? null,
  });
}

module.exports = { writeAudit };
