'use strict';

const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

// Metaview's start_time values are UTC. Without an explicit IANA timeZone,
// Date#toLocaleString renders in whatever timezone the Node process happens
// to run in (e.g. UTC on a server) - not the interviewer's local time. Always
// pass the company timezone (config.json's `timezone`) through explicitly.
function formatDate(iso, timeZone = DEFAULT_TIME_ZONE) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
}

function formatTime(iso, timeZone = DEFAULT_TIME_ZONE) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Formats a date-only "YYYY-MM-DD" string without going through Date's
 * UTC/local timezone conversion (which can shift date-only strings back a
 * day in negative-offset timezones).
 */
function formatIsoDateLabel(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// Kaily's read on why misses happen: often people just don't know how the
// admit prompt works or why it matters, not that they're ignoring it. A
// short, optional pointer to the internal quick-reference doc goes right
// before the closing line in both templates, so it reads as helpful context
// rather than a lecture. Omitted entirely if no resourceUrl is configured.
function resourceLine(resourceUrl) {
  return resourceUrl ? `\n\nNew to Metaview or forgot how the admit prompt works? [Quick reference](${resourceUrl})` : '';
}

function singleMissMessage({ firstName, eventName, date, resourceUrl }) {
  return `Hey ${firstName} — Metaview didn't capture notes for ${eventName} on ${date}. Mind letting us know what happened so we can track it down?

a) Forgot to admit it when it asked to join
b) Tried to admit it but it didn't work
c) It looked like it joined fine on your end
d) Something else${resourceLine(resourceUrl)}

No stress, just gathering info 🙏`;
}

function multiMissMessage({ firstName, misses, resourceUrl }) {
  const lines = misses.map((m) => `• ${m.eventName} (${m.time})`).join('\n');
  return `Hey ${firstName} — Metaview wasn't able to join a couple of your calls:
${lines}

For each one, was it: a) forgot to admit, b) tried but didn't work, c) actually joined fine, or d) something else? No worries either way, just want the data 🙏${resourceLine(resourceUrl)}`;
}

/**
 * Renders the DM text for one interviewer's group of misses. Single miss
 * uses the terse template; 2+ misses in the same run are combined into one
 * message instead of separate DMs, per the build spec.
 */
function renderNudgeMessage(group, { timeZone = DEFAULT_TIME_ZONE, resourceUrl = null } = {}) {
  const fname = require('./filters').firstName(group.interviewerName);
  if (group.misses.length === 1) {
    const m = group.misses[0];
    return singleMissMessage({ firstName: fname, eventName: m.eventName, date: formatDate(m.startTime, timeZone), resourceUrl });
  }
  return multiMissMessage({
    firstName: fname,
    misses: group.misses.map((m) => ({
      eventName: m.eventName,
      time: `${formatDate(m.startTime, timeZone)}, ${formatTime(m.startTime, timeZone)}`,
    })),
    resourceUrl,
  });
}

module.exports = { formatDate, formatTime, formatIsoDateLabel, singleMissMessage, multiMissMessage, renderNudgeMessage };
