#!/usr/bin/env node
'use strict';

/**
 * Friday 10am outreach-list runner - a lightweight mid-week companion to
 * the Monday Canvas sit-rep. Filters the full nudge log down to this
 * week's misses (by `sentAt`, i.e. when the nudge actually went out) and
 * renders a plain Slack message listing who's been reached out to so far.
 *
 * Usage: node bin/outreach-runner.js < input.json > output.json
 *
 * Input JSON shape:
 * {
 *   "entries": [ <the full state/sit-rep-log.json array> ],
 *   "windowStartISO": "2026-08-10T07:00:00.000Z",  // from `node bin/window.js week-so-far`
 *   "windowEndISO": "2026-08-14T17:00:00.000Z",
 *   "timezone": "America/Los_Angeles"
 * }
 */

const { renderOutreachReport, groupEntriesByInterviewer } = require('../lib/outreach');
const { formatDate } = require('../lib/templates');

function readStdin() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  return new Promise((resolve, reject) => {
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}');
  const timeZone = input.timezone || 'America/Los_Angeles';
  const windowStart = new Date(input.windowStartISO);
  const windowEnd = new Date(input.windowEndISO);

  const thisWeek = (input.entries || []).filter((e) => {
    if (!e.sentAt) return false;
    const t = new Date(e.sentAt).getTime();
    return t >= windowStart.getTime() && t <= windowEnd.getTime();
  });

  const weekStartLabel = formatDate(windowStart.toISOString(), timeZone);
  const weekEndLabel = formatDate(windowEnd.toISOString(), timeZone);

  const text = renderOutreachReport(thisWeek, { weekStartLabel, weekEndLabel });
  const groups = groupEntriesByInterviewer(thisWeek);

  const output = {
    text,
    stats: { missCount: thisWeek.length, interviewerCount: groups.length },
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
