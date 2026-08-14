#!/usr/bin/env node
'use strict';

/**
 * Weekly sit-rep CLI runner.
 *
 * Bridges: (a) this week's log entries (misses already sent via the daily
 * nudge, with raw Slack reply text attached by the calling prompt after it
 * read each thread), (b) a fresh Metaview query of this week's *recorded*
 * real candidate interviews, (c) trailing-4-week log entries for the
 * repeat-pattern section, and (d) prior weeks' summaries - into rendered
 * Canvas sections plus updated state to persist.
 *
 * Does no network I/O itself. The calling prompt: reads Slack threads,
 * queries Metaview, feeds everything in here, then writes updatedLogEntries
 * back via bin/append-log.js, writes updatedHistory to
 * state/weekly-history.json, and creates/updates the Slack Canvas from
 * canvasSections.
 *
 * Usage: node bin/weekly-runner.js < input.json > output.json
 *
 * Input JSON shape:
 * {
 *   "weekStartISO": "2026-08-10", "weekEndISO": "2026-08-16",
 *   "timestamp": "2026-08-17T08:00:00-07:00",
 *   "weekLogEntries": [ <log entries dated in this week, each optionally
 *                        carrying a fresh "rawReplyText" from Slack, or
 *                        omitting it to keep whatever reason/replyRaw the
 *                        entry already had> ],
 *   "trailing4WeeksLogEntries": [ <log entries from the last 4 weeks,
 *                                  including this week's (pre-update)
 *                                  copies - this week's updated versions
 *                                  are substituted in automatically> ],
 *   "recordedConversations": [ <raw Metaview rows, only_show_recorded_conversations: true,
 *                               same fields as the daily nudge query> ],
 *   "fields": { "candidate": "default:candidate", "department": "OSPT:<field-id>" },
 *   "history": [ { "weekStartISO": "2026-08-03", "weekEndISO": "2026-08-09",
 *                   "scheduled": N, "missed": N, "missRate": N } ... ],  // ascending, oldest first
 *   "timezone": "America/Los_Angeles"   // IANA zone for the "Last updated" timestamp; defaults to America/Los_Angeles
 * }
 */

const { filterRealMisses, deptLabel } = require('../lib/filters');
const { formatIsoDateLabel } = require('../lib/templates');
const { parseReply, missRate, trendArrow, tallyReasons, byTeamRows, repeatOffenders } = require('../lib/aggregate');
const { renderCanvasSections } = require('../lib/canvas-render');

function readStdin() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  return new Promise((resolve, reject) => {
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function resolveReply(entry) {
  if (entry.rawReplyText === undefined) {
    // No fresh read this run - keep whatever was already persisted.
    const { rawReplyText, ...rest } = entry;
    return rest;
  }
  const parsed = parseReply(entry.rawReplyText);
  const { rawReplyText, ...rest } = entry;
  return { ...rest, reason: parsed.code, replyRaw: parsed.raw };
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}');

  const fields = Object.assign({ candidate: 'default:candidate', department: null }, input.fields || {});
  const now = new Date();

  const updatedWeekEntries = (input.weekLogEntries || []).map(resolveReply);
  const updatedById = new Map(updatedWeekEntries.map((e) => [e.id, e]));

  const trailing4Weeks = (input.trailing4WeeksLogEntries || []).map((e) => updatedById.get(e.id) || e);

  const recordedReal = filterRealMisses(input.recordedConversations || [], fields, { now, requirePast: false });

  const missed = updatedWeekEntries.length;
  const scheduled = recordedReal.length + missed;
  const thisWeekMissRate = missRate(missed, scheduled);

  const history = input.history || [];
  const priorWeek = history.length ? history[history.length - 1] : null;
  const lastWeekRate = priorWeek ? priorWeek.missRate : null;
  const arrow = trendArrow(thisWeekMissRate, lastWeekRate);

  const reasonTally = tallyReasons(updatedWeekEntries);

  const byTeam = byTeamRows(
    recordedReal,
    updatedWeekEntries,
    (r) => deptLabel(r, fields.department) || 'Unknown',
    (m) => m.department || 'Unknown'
  );

  const offenders = repeatOffenders(trailing4Weeks);

  const summary = {
    weekStartISO: input.weekStartISO,
    weekEndISO: input.weekEndISO,
    scheduled,
    missed,
    missRate: thisWeekMissRate,
  };

  const updatedHistory = [...history, summary]
    .filter((w, idx, arr) => arr.findIndex((x) => x.weekStartISO === w.weekStartISO) === idx)
    .sort((a, b) => (a.weekStartISO < b.weekStartISO ? -1 : 1))
    .slice(-5);

  const trend = updatedHistory.map((w) => ({ weekStart: formatIsoDateLabel(w.weekStartISO), missRate: w.missRate }));

  const canvasSections = renderCanvasSections({
    weekStart: formatIsoDateLabel(input.weekStartISO),
    weekEnd: formatIsoDateLabel(input.weekEndISO),
    timestamp: new Date(input.timestamp || now).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: input.timezone || 'America/Los_Angeles',
    }),
    scheduled,
    missed,
    missRate: thisWeekMissRate,
    lastWeekRate: lastWeekRate == null ? 0 : lastWeekRate,
    trendArrow: arrow,
    reasonBreakdown: reasonTally.breakdown,
    byTeam,
    repeatOffenders: offenders,
    trend,
  });

  const output = {
    summary,
    canvasSections,
    updatedHistory,
    updatedLogEntries: updatedWeekEntries,
    stats: {
      recordedRealCount: recordedReal.length,
      missedCount: missed,
      scheduledCount: scheduled,
      repeatOffenderCount: offenders.length,
    },
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
