'use strict';

const REASON_LABELS = {
  a: 'Forgot to admit',
  b: "Tried, didn't work",
  c: 'Actually joined fine (false positive)',
  d: 'Something else',
  e: 'Cancelled/rescheduled — no call happened',
};

/**
 * Parses a Slack reply against the daily nudge's a/b/c/d/e template.
 * Accepts "a", "a)", "a.", "a -", "a: ..." (case-insensitive), each
 * optionally followed by free text. Anything else is kept as free text
 * tagged "other" rather than discarded, so no reply is silently dropped.
 */
function parseReply(text) {
  if (text == null) return { code: null, isOther: false, raw: null };
  const trimmed = String(text).trim();
  if (!trimmed) return { code: null, isOther: false, raw: null };
  // Matches a leading a/b/c/d/e that stands alone or is followed by a
  // separator (")", ".", ":", "-", whitespace) - e.g. "a", "a)", "a) forgot".
  // Anything else (including a word that merely starts with a/b/c/d/e) is
  // treated as free text.
  const match = trimmed.match(/^\(?([a-eA-E])\)?(?:[.:\-]|\s|$)/);
  if (match) {
    return { code: match[1].toLowerCase(), isOther: false, raw: trimmed };
  }
  return { code: null, isOther: true, raw: trimmed };
}

function missRate(missed, scheduled) {
  if (!scheduled) return 0;
  return Math.round((missed / scheduled) * 1000) / 10;
}

function trendArrow(current, previous) {
  if (previous == null) return '→';
  if (current < previous) return '↓';
  if (current > previous) return '↑';
  return '→';
}

/**
 * Tallies reply reasons for a set of log entries. Entries carry `.reason`
 * (the a/b/c/d/e code, or null) and `.replyRaw` (free text when not a clean
 * a/b/c/d/e match, or null when there's no reply yet). Takes the full set of
 * entries for the week - including reason "e" (cancelled/rescheduled) ones -
 * so the breakdown stays a complete picture; callers that compute the miss
 * rate/by-team/repeat-offender numbers should filter reason "e" out of
 * *those* first, since a call that never happened isn't a real miss (see
 * bin/weekly-runner.js).
 */
function tallyReasons(entries) {
  const counts = { a: 0, b: 0, c: 0, d: 0, e: 0, other: 0, noReply: 0 };
  for (const e of entries) {
    if (e.replyRaw == null && e.reason == null) {
      counts.noReply++;
    } else if (e.reason && counts[e.reason] !== undefined) {
      counts[e.reason]++;
    } else {
      counts.other++;
    }
  }
  const total = entries.length;
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  const breakdown = [
    { key: 'a', reason: REASON_LABELS.a, count: counts.a, pct: pct(counts.a) },
    { key: 'b', reason: REASON_LABELS.b, count: counts.b, pct: pct(counts.b) },
    { key: 'c', reason: REASON_LABELS.c, count: counts.c, pct: pct(counts.c) },
    { key: 'noReply', reason: 'No reply yet', count: counts.noReply, pct: pct(counts.noReply) },
    { key: 'd', reason: REASON_LABELS.d, count: counts.d, pct: pct(counts.d) },
    { key: 'e', reason: `${REASON_LABELS.e} (excluded from miss rate)`, count: counts.e, pct: pct(counts.e) },
    { key: 'other', reason: 'Other (free text) — see raw reply', count: counts.other, pct: pct(counts.other) },
  ];
  return { total, counts, breakdown };
}

function groupCountByDept(items, getDept) {
  const counts = new Map();
  for (const item of items) {
    const dept = getDept(item) || 'Unknown';
    counts.set(dept, (counts.get(dept) || 0) + 1);
  }
  return counts;
}

/**
 * Builds by-team rows. `recordedItems` are this week's real candidate
 * interviews that WERE recorded (fetched fresh from Metaview); `missedItems`
 * are this week's log entries (already known misses). A team's "scheduled"
 * count is recorded + missed for that team, so misses are never invisible
 * to their own team's denominator.
 */
function byTeamRows(recordedItems, missedItems, getDeptFromRecorded, getDeptFromMissed) {
  const recordedCounts = groupCountByDept(recordedItems, getDeptFromRecorded);
  const missedCounts = groupCountByDept(missedItems, getDeptFromMissed);
  const teams = new Set([...recordedCounts.keys(), ...missedCounts.keys()]);
  return Array.from(teams)
    .map((team) => {
      const missed = missedCounts.get(team) || 0;
      const scheduled = (recordedCounts.get(team) || 0) + missed;
      return { team, missed, scheduled, missRate: missRate(missed, scheduled) };
    })
    .sort((a, b) => b.missRate - a.missRate);
}

/**
 * Anyone with 2+ misses across the trailing 4 weeks (this week included).
 * Framed in the canvas as a heads-up for 1:1 context, not a public callout.
 */
function repeatOffenders(trailing4WeeksEntries, { minMisses = 2 } = {}) {
  const byPerson = new Map();
  for (const e of trailing4WeeksEntries) {
    const key = e.interviewerSlackId || e.interviewerName;
    if (!key) continue;
    if (!byPerson.has(key)) {
      byPerson.set(key, { name: e.interviewerName, slackId: e.interviewerSlackId, entries: [] });
    }
    byPerson.get(key).entries.push(e);
  }
  const result = [];
  for (const person of byPerson.values()) {
    if (person.entries.length < minMisses) continue;
    const tally = tallyReasons(person.entries);
    const breakdown = tally.breakdown
      .filter((b) => b.count > 0)
      .map((b) => `${b.count} ${b.reason.toLowerCase()}`)
      .join(', ');
    result.push({ name: person.name, count: person.entries.length, breakdown: breakdown || 'no replies yet' });
  }
  result.sort((a, b) => b.count - a.count);
  return result;
}

module.exports = {
  REASON_LABELS,
  parseReply,
  missRate,
  trendArrow,
  tallyReasons,
  groupCountByDept,
  byTeamRows,
  repeatOffenders,
};
