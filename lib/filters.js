'use strict';

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isEmptyParticipantList(value) {
  return toArray(value).length === 0;
}

function isPast(startTime, now = new Date()) {
  const t = new Date(startTime);
  return !Number.isNaN(t.getTime()) && t.getTime() <= now.getTime();
}

function participantName(participant) {
  if (!participant) return null;
  if (typeof participant === 'string') return participant;
  return participant.name || participant.full_name || participant.email || null;
}

function participantEmail(participant) {
  if (!participant || typeof participant !== 'object') return null;
  return participant.email || null;
}

function participantSlackId(participant) {
  if (!participant || typeof participant !== 'object') return null;
  return participant.slack_id || participant.slack_user_id || null;
}

function firstName(fullName) {
  if (!fullName) return 'there';
  return fullName.trim().split(/\s+/)[0];
}

/** Normalizes an OSPT department field value (may be a string, an object, or a list field) to a plain label. */
function deptLabel(value) {
  if (value == null) return null;
  const arr = toArray(value);
  if (arr.length === 0) return null;
  const first = arr[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') return first.name || first.label || first.value || null;
  return null;
}

/**
 * Metaview's "unrecorded" bucket mixes real missed candidate interviews with
 * recurring internal syncs that were never supposed to have a bot in them
 * (some mislabeled with an interview-sounding conversation_type). A non-empty
 * candidate list is the only reliable signal that this was an actual
 * candidate-facing interview, so conversation_type is deliberately not part
 * of this check - see the build spec for why.
 */
function filterRealMisses(conversations, fields, { now = new Date(), requirePast = true } = {}) {
  return conversations.filter((c) => {
    if (isEmptyParticipantList(c[fields.candidate])) return false;
    if (requirePast && !isPast(c[fields.startTime], now)) return false;
    return true;
  });
}

/**
 * Fans a list of miss conversations out into one group per internal
 * interviewer. A conversation with multiple interviewers appears in each of
 * their groups so nobody with a stake in the call is missed.
 */
function groupByInterviewer(misses, fields) {
  const groups = new Map();
  for (const conv of misses) {
    const interviewers = toArray(conv[fields.interviewer]);
    for (const interviewer of interviewers) {
      const name = participantName(interviewer);
      const email = participantEmail(interviewer);
      const slackId = participantSlackId(interviewer);
      const key = slackId || email || name;
      if (!key) continue;
      const dept = fields.department ? deptLabel(conv[fields.department]) : null;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          interviewerName: name,
          interviewerEmail: email,
          interviewerSlackId: slackId,
          department: dept,
          misses: [],
        });
      }
      const group = groups.get(key);
      if (!group.interviewerSlackId && slackId) group.interviewerSlackId = slackId;
      if (!group.department && dept) group.department = dept;
      group.misses.push({
        conversationId: conv.conversation_id ?? conv.id ?? null,
        eventName: conv[fields.eventTitle] || 'Untitled interview',
        startTime: conv[fields.startTime],
        department: dept,
      });
    }
  }
  return Array.from(groups.values());
}

module.exports = {
  toArray,
  isEmptyParticipantList,
  isPast,
  participantName,
  participantEmail,
  participantSlackId,
  firstName,
  deptLabel,
  filterRealMisses,
  groupByInterviewer,
};
