#!/usr/bin/env node
'use strict';

/**
 * Prints the ISO start/end bounds for a query window, so the daily/weekly
 * prompts never have to hand-compute "which business day" or "Monday of
 * this week" via bash date arithmetic - the Fri-to-Monday rollover and
 * timezone-correct local midnight are easy to get subtly wrong that way.
 *
 * Usage:
 *   node bin/window.js previous-business-day [--timezone=IANA] [--now=ISO]
 *   node bin/window.js today-so-far          [--timezone=IANA] [--now=ISO]
 *   node bin/window.js week-so-far           [--timezone=IANA] [--now=ISO]
 *
 * --now defaults to the real current time; pass it for reproducible/manual
 * runs. Prints { startISO, endISO, dateLabel|weekStartDateLabel } as JSON.
 */

const { previousBusinessDayWindow, todaySoFarWindow, weekSoFarWindow } = require('../lib/schedule');

function parseArgs(argv) {
  const mode = argv[0];
  const opts = { timezone: 'America/Los_Angeles', now: null };
  for (const arg of argv.slice(1)) {
    const m = arg.match(/^--([a-z]+)=(.*)$/);
    if (m) opts[m[1]] = m[2];
  }
  return { mode, opts };
}

function main() {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  const now = opts.now ? new Date(opts.now) : new Date();
  const timeZone = opts.timezone;

  let result;
  if (mode === 'previous-business-day') {
    result = previousBusinessDayWindow(now, timeZone);
  } else if (mode === 'today-so-far') {
    result = todaySoFarWindow(now, timeZone);
  } else if (mode === 'week-so-far') {
    result = weekSoFarWindow(now, timeZone);
  } else {
    console.error('Usage: node bin/window.js <previous-business-day|today-so-far|week-so-far> [--timezone=IANA] [--now=ISO]');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
