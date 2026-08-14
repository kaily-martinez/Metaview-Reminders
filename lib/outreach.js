'use strict';

/** Groups sit-rep-log entries by interviewer, busiest first. */
function groupEntriesByInterviewer(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = e.interviewerSlackId || e.interviewerName;
    if (!groups.has(key)) {
      groups.set(key, { interviewerName: e.interviewerName, entries: [] });
    }
    groups.get(key).entries.push(e);
  }
  return Array.from(groups.values()).sort(
    (a, b) => b.entries.length - a.entries.length || a.interviewerName.localeCompare(b.interviewerName)
  );
}

/**
 * Renders a plain Slack message (not a Canvas) listing who's been nudged so
 * far this week - a lighter-weight, mid-week companion to the Monday
 * Canvas sit-rep, which also carries reply data and trends.
 */
function renderOutreachReport(entries, { weekStartLabel, weekEndLabel }) {
  const groups = groupEntriesByInterviewer(entries);
  const title = `📋 *Metaview outreach this week* (${weekStartLabel}–${weekEndLabel}) — ${entries.length} miss${
    entries.length === 1 ? '' : 'es'
  } across ${groups.length} interviewer${groups.length === 1 ? '' : 's'}`;

  if (groups.length === 0) {
    return `${title}\n\nNo misses logged yet this week 🎉`;
  }

  const lines = groups.map((g) => {
    if (g.entries.length === 1) {
      const e = g.entries[0];
      return `• *${g.interviewerName}* — ${e.eventName} (${e.date})`;
    }
    const details = g.entries.map((e) => `${e.eventName} (${e.date})`).join(', ');
    return `• *${g.interviewerName}* — ${g.entries.length} misses: ${details}`;
  });

  return `${title}\n\n${lines.join('\n')}`;
}

module.exports = { groupEntriesByInterviewer, renderOutreachReport };
