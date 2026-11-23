'use strict';

/**
 * Service errors carry an HTTP status and a short machine-readable code. The
 * error handler in app.js turns them into a consistent JSON body:
 *   { "error": { "code": "…", "message": "…" } }
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
const validationFailed = (fields) =>
  new ApiError(422, 'validation_failed', 'Please check the highlighted fields.', { fields });
const unauthorized = (message = 'You need to sign in first.') =>
  new ApiError(401, 'unauthorized', message);
const forbidden = (message = 'You are not allowed to do that.') =>
  new ApiError(403, 'forbidden', message);
const notFound = (message = 'That item does not exist.') => new ApiError(404, 'not_found', message);
const conflict = (message, details) => new ApiError(409, 'conflict', message, details);
const tooManyRequests = (message) => new ApiError(429, 'too_many_requests', message);

module.exports = {
  ApiError,
  badRequest,
  validationFailed,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
};
