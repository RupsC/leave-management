'use strict';

/**
 * Date helpers. Everything is a plain 'YYYY-MM-DD' string in UTC so the stored
 * data never depends on the server's time zone.
 *
 * LEAVE COUNTING RULE (documented in the README as well):
 *  - weekends (Saturday and Sunday) are never counted;
 *  - public holidays are NOT modelled, so a weekday holiday counts as leave;
 *  - a half day (morning or afternoon) counts as 0.5 and only on a single day.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function isValidDate(value) {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function toUtc(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmt(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(value, days) {
  const date = toUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return fmt(date);
}

function isWeekend(value) {
  const day = toUtc(value).getUTCDay();
  return day === 0 || day === 6;
}

/** Every date from start to end inclusive. */
function eachDate(start, end) {
  const out = [];
  if (!isValidDate(start) || !isValidDate(end) || end < start) return out;
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 4000) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}

/** Monday-to-Friday days between start and end inclusive. */
function countWorkingDays(start, end) {
  return eachDate(start, end).filter((date) => !isWeekend(date)).length;
}

/** Days charged against the balance, taking a half day into account. */
function countLeaveDays(start, end, halfDay = 'none') {
  if (halfDay === 'am' || halfDay === 'pm') return 0.5;
  return countWorkingDays(start, end);
}

function isValidMonth(value) {
  if (typeof value !== 'string') return false;
  const match = MONTH_RE.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function monthBounds(month) {
  const [year, m] = month.split('-').map(Number);
  const start = `${year}-${pad(m)}-01`;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { start, end: `${year}-${pad(m)}-${pad(lastDay)}` };
}

function todayIso() {
  // The demo runs in India; report "today" in the server's local calendar day.
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nowIso() {
  return new Date().toISOString();
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

function overlapDates(aStart, aEnd, bStart, bEnd) {
  if (!overlaps(aStart, aEnd, bStart, bEnd)) return [];
  const from = aStart > bStart ? aStart : bStart;
  const to = aEnd < bEnd ? aEnd : bEnd;
  return eachDate(from, to);
}

module.exports = {
  isValidDate,
  isValidMonth,
  monthBounds,
  eachDate,
  countWorkingDays,
  countLeaveDays,
  isWeekend,
  addDays,
  todayIso,
  nowIso,
  overlaps,
  overlapDates,
  toUtc,
  fmt,
};
