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

// Short zone abbreviation (e.g. "PDT", "PST") so a displayed time is
// unambiguous regardless of what timezone the reader assumes.
function formatTimeZoneAbbr(iso, timeZone = DEFAULT_TIME_ZONE) {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(d);
  const tz = parts.find((p) => p.type === 'timeZoneName');
  return tz ? tz.value : '';
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
  return resourceUrl
    ? `\n\nCheck out our [Metaview: Admit & Submit Guide](${resourceUrl}). Admit the bot into your interview call. It auto-records and takes notes so you can focus on the conversation, and makes submitting your scorecard faster. Required for all interviews at Luma.`
    : '';
}

// Always listed one per line, in both templates - a single inlined
// sentence ("was it: a) ... b) ... c) ... or d) ...?") reads faster to
// write but slower to actually answer against. "e" exists because a real
// chunk of "misses" turned out to be calls that were cancelled or
// rescheduled - nothing to admit Metaview into, so nothing to hold against
// the interviewer - and free-texting that as "d) something else" made it
// indistinguishable from an actual problem.
const REPLY_OPTIONS = `a) Forgot to admit Metaview
b) Tried to admit Metaview but it didn't work
c) It looked like it joined fine on my end
d) Something else
e) The interview was cancelled or rescheduled - no call happened`;

// Small aside at the very bottom of every nudge, after the sign-off - a
// reminder that this is an automated bot still learning the ropes, so a
// terse or confused reply doesn't land as more formal than intended.
const BABY_BOT_LINE = "\n\n_P.S. I'm a baby bot and still learning 🙂_";

function singleMissMessage({ firstName, eventName, candidateName, date, resourceUrl }) {
  const withCandidate = candidateName ? `${eventName} with ${candidateName}` : eventName;
  return `Hey ${firstName} — Metaview didn't capture notes for ${withCandidate} on ${date}. Mind letting us know what happened so we can track it down?

${REPLY_OPTIONS}${resourceLine(resourceUrl)}

No stress, just gathering info 🙏${BABY_BOT_LINE}`;
}

function multiMissMessage({ firstName, misses, resourceUrl }) {
  const lines = misses
    .map((m) => {
      const withCandidate = m.candidateName ? `${m.eventName} with ${m.candidateName}` : m.eventName;
      return `• ${withCandidate} (${m.time})`;
    })
    .join('\n');
  return `Hey ${firstName} — Metaview wasn't able to join a couple of your calls:
${lines}

For each one, let us know what happened:

${REPLY_OPTIONS}

No worries either way, just want the data 🙏${resourceLine(resourceUrl)}${BABY_BOT_LINE}`;
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
    return singleMissMessage({
      firstName: fname,
      eventName: m.eventName,
      candidateName: m.candidateName,
      date: formatDate(m.startTime, timeZone),
      resourceUrl,
    });
  }
  return multiMissMessage({
    firstName: fname,
    misses: group.misses.map((m) => ({
      eventName: m.eventName,
      candidateName: m.candidateName,
      time: `${formatDate(m.startTime, timeZone)}, ${formatTime(m.startTime, timeZone)} ${formatTimeZoneAbbr(m.startTime, timeZone)}`,
    })),
    resourceUrl,
  });
}

module.exports = {
  formatDate,
  formatTime,
  formatTimeZoneAbbr,
  formatIsoDateLabel,
  singleMissMessage,
  multiMissMessage,
  renderNudgeMessage,
};
