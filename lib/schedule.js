'use strict';

/**
 * Finds the UTC instant that reads as local midnight (00:00:00) on
 * {y}-{m}-{d} in `timeZone`, without relying on Date's "no zone info parses
 * as host-local time" behavior. Converges in 1-2 iterations except right at
 * a DST transition.
 */
function zonedMidnightToUTC(y, m, d, timeZone) {
  const target = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(guess));
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const localAsUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second)
    );
    const delta = target - localAsUTC;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

/** Local calendar Y/M/D and day-of-week (0=Sun..6=Sat) for `date` in `timeZone`. */
function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), dow: WEEKDAYS[map.weekday] };
}

/** Shifts a Y/M/D by `days` (may be negative) using UTC as neutral calendar scratch space. */
function shiftDate(y, m, d, days) {
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * The full local-day window [local midnight, next local midnight) for the
 * most recent business day before `now`, in `timeZone`. Weekday cron runs
 * (Tue-Fri) land on the prior calendar day; a Monday run rolls back to the
 * preceding Friday so Friday's interviews aren't silently skipped when the
 * job doesn't run over the weekend.
 */
function previousBusinessDayWindow(now, timeZone) {
  const { year, month, day, dow } = localDateParts(now, timeZone);
  const daysBack = dow === 1 ? 3 : dow === 0 ? 2 : 1; // Mon->Fri(-3), Sun->Fri(-2), else -1
  const target = shiftDate(year, month, day, -daysBack);
  const start = zonedMidnightToUTC(target.year, target.month, target.day, timeZone);
  const next = shiftDate(target.year, target.month, target.day, 1);
  const end = zonedMidnightToUTC(next.year, next.month, next.day, timeZone);
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    dateLabel: isoDate(target.year, target.month, target.day),
  };
}

/** The local-day window [local midnight, now] for "today so far" - used for manual/testing runs only. */
function todaySoFarWindow(now, timeZone) {
  const { year, month, day } = localDateParts(now, timeZone);
  const start = zonedMidnightToUTC(year, month, day, timeZone);
  return { startISO: start.toISOString(), endISO: now.toISOString(), dateLabel: isoDate(year, month, day) };
}

/** Monday-of-this-week's local midnight through `now`, in `timeZone` - "this week so far". */
function weekSoFarWindow(now, timeZone) {
  const { year, month, day, dow } = localDateParts(now, timeZone);
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const monday = shiftDate(year, month, day, -daysSinceMonday);
  const start = zonedMidnightToUTC(monday.year, monday.month, monday.day, timeZone);
  return { startISO: start.toISOString(), endISO: now.toISOString(), weekStartDateLabel: isoDate(monday.year, monday.month, monday.day) };
}

module.exports = { zonedMidnightToUTC, localDateParts, shiftDate, previousBusinessDayWindow, todaySoFarWindow, weekSoFarWindow };
