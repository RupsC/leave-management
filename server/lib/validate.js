'use strict';

const { isValidDate, addDays, todayIso } = require('./dates');

/**
 * Small hand-written validator. Every value that reaches the database has been
 * through here: required fields, lengths, date formats, allowed values.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

function validate(body, schema) {
  const source = body && typeof body === 'object' ? body : {};
  const value = {};
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });

  for (const [field, rule] of Object.entries(schema)) {
    const label = rule.label || field;
    const raw = source[field];

    if (isBlank(raw)) {
      if (rule.required) {
        fail(field, `${label} is required.`);
        continue;
      }
      if (rule.default !== undefined) value[field] = rule.default;
      continue;
    }

    if (Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) {
      fail(field, `${label} must be a single value.`);
      continue;
    }

    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (typeof raw === 'string' && text === '') {
      if (rule.required) fail(field, `${label} is required.`);
      continue;
    }

    switch (rule.type) {
      case 'string': {
        const str = String(text);
        if (rule.min && str.length < rule.min) {
          fail(field, `${label} must be at least ${rule.min} characters.`);
          continue;
        }
        if (rule.max && str.length > rule.max) {
          fail(field, `${label} must be ${rule.max} characters or fewer.`);
          continue;
        }
        value[field] = str;
        break;
      }
      case 'email': {
        const str = String(text);
        if (rule.max && str.length > rule.max) {
          fail(field, `${label} must be ${rule.max} characters or fewer.`);
          continue;
        }
        if (!EMAIL_RE.test(str)) {
          fail(field, `${label} must look like name@example.com.`);
          continue;
        }
        value[field] = str.toLowerCase();
        break;
      }
      case 'integer': {
        if (typeof text === 'boolean' || !/^-?\d+$/.test(String(text))) {
          fail(field, `${label} must be a whole number.`);
          continue;
        }
        const num = Number(text);
        if (rule.min !== undefined && num < rule.min) {
          fail(field, `${label} must be ${rule.min} or more.`);
          continue;
        }
        if (rule.max !== undefined && num > rule.max) {
          fail(field, `${label} must be ${rule.max} or less.`);
          continue;
        }
        value[field] = num;
        break;
      }
      case 'date': {
        const str = String(text);
        if (!isValidDate(str)) {
          fail(field, `${label} must be a real date in the form YYYY-MM-DD.`);
          continue;
        }
        if (rule.notBefore && str < rule.notBefore) {
          fail(field, `${label} cannot be earlier than ${rule.notBefore}.`);
          continue;
        }
        if (rule.notAfter && str > rule.notAfter) {
          fail(field, `${label} cannot be later than ${rule.notAfter}.`);
          continue;
        }
        value[field] = str;
        break;
      }
      case 'enum': {
        const allowed = rule.values || [];
        const found = allowed.find((candidate) => String(candidate) === String(text));
        if (found === undefined) {
          fail(field, `${label} must be one of: ${allowed.map(String).join(', ')}.`);
          continue;
        }
        value[field] = found;
        break;
      }
      default:
        fail(field, `${label} has an unsupported type.`);
    }
  }

  return { value, errors };
}

/** Cross-field checks that only make sense once both dates are known. */
function checkDateRange(startDate, endDate, { maxSpanDays = 120 } = {}) {
  const errors = [];
  if (!isValidDate(startDate) || !isValidDate(endDate)) return errors;
  if (endDate < startDate) {
    errors.push({ field: 'endDate', message: 'End date cannot be before the start date.' });
    return errors;
  }
  const span =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (span > maxSpanDays) {
    errors.push({
      field: 'endDate',
      message: `A single request cannot span more than ${maxSpanDays} days.`,
    });
  }
  const limit = addDays(todayIso(), 365 * 3);
  if (startDate > limit) {
    errors.push({ field: 'startDate', message: 'Leave can be booked at most three years ahead.' });
  }
  return errors;
}

/** Positive integer id from a URL or query string, or null. */
function parseId(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw.trim())) return null;
  const num = Number(raw.trim());
  return num > 0 ? num : null;
}

module.exports = { validate, checkDateRange, parseId, EMAIL_RE };
