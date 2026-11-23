const KEYS = ['sessions', 'signin_attempts', 'audit_logs', 'notifications', 'decisions', 'attachments', 'leave_requests', 'leave_balances', 'leave_types', 'users'];

/**
 * A tiny in-memory stand-in for the rate limiter, so tests never share state.
 * (Kept here so the test files stay readable.)
 */
function resetCache() {
  return KEYS.length;
}

module.exports = { resetCache, KEYS };
