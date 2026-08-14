'use strict';

// Metaview's search_conversations rows look like:
//   { id: 477697884, url: "...", fields: {
//       "default:interviewer": [{ value: uuid, label: "Name", details: { name, emails: [...], phone_numbers: [...] } }, ...],
//       "default:candidate": [ ...same shape... ],
//       "default:calendar_event_title": [{ value: "title", label: "title" }],
//       "default:start_time": [{ value: "2026-08-14 22:00:00+00:00", label: "..." }],
//       "OSPT:<dept-field-id>": [{ value: "Engineering", label: "Engineering" }]   // or [] if unset
//   } }
// Every field value is a list, even single-value scalar fields - this module
// centralizes the extraction so callers never have to know that.

function toArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Reads a field's raw value list off a search_conversations row. */
function getFieldItems(conv, fieldId) {
  if (!fieldId) return [];
  const raw = conv.fields ? conv.fields[fieldId] : conv[fieldId];
  return toArray(raw);
}

function isEmptyParticipantList(conv, fieldId) {
  return getFieldItems(conv, fieldId).length === 0;
}

function isPast(startTimeStr, now = new Date()) {
  if (!startTimeStr) return false;
  const t = new Date(startTimeStr);
  return !Number.isNaN(t.getTime()) && t.getTime() <= now.getTime();
}

/** First scalar value off a non-participant field (event title, start time, department, ...). */
function scalarFieldValue(conv, fieldId) {
  const items = getFieldItems(conv, fieldId);
  if (items.length === 0) return null;
  const first = items[0];
  if (typeof first === 'string') return first;
  return first.value ?? first.label ?? null;
}

function participantName(item) {
  if (!item) return null;
  if (typeof item === 'string') return item;
  return (item.details && item.details.name) || item.label || null;
}

function participantEmail(item) {
  if (!item || typeof item !== 'object') return null;
  const emails = item.details && item.details.emails;
  return Array.isArray(emails) && emails.length ? emails[0] : null;
}

function participantSlackId(item) {
  if (!item || typeof item !== 'object') return null;
  return item.slack_id || item.slack_user_id || (item.details && item.details.slack_id) || null;
}

function firstName(fullName) {
  if (!fullName) return 'there';
  return fullName.trim().split(/\s+/)[0];
}

/** Normalizes an OSPT department field's first value to a plain label. */
function deptLabel(conv, fieldId) {
  return fieldId ? scalarFieldValue(conv, fieldId) : null;
}

/**
 * Metaview's "unrecorded" bucket mixes real missed candidate interviews with
 * recurring internal syncs that were never supposed to have a bot in them
 * (some mislabeled with an interview-sounding conversation_type). A non-empty
 * candidate list catches most of that noise, but not all of it - live data
 * showed a vendor sync and an internal leadership sync both carrying a
 * (spurious) candidate participant. So this also accepts an optional
 * conversation_type allowlist (Job Interview / Coding Interview / System
 * Design Interview, not Candidate Debrief / Client Call / Role Intake /
 * Other) as a second, independent signal - both checks must pass.
 */
function filterRealMisses(conversations, fields, { now = new Date(), requirePast = true, allowedConversationTypeIds = null } = {}) {
  return conversations.filter((c) => {
    if (isEmptyParticipantList(c, fields.candidate)) return false;
    if (requirePast && !isPast(scalarFieldValue(c, fields.startTime), now)) return false;
    if (allowedConversationTypeIds && fields.conversationType) {
      const typeId = scalarFieldValue(c, fields.conversationType);
      if (!allowedConversationTypeIds.includes(typeId)) return false;
    }
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
    const interviewers = getFieldItems(conv, fields.interviewer);
    const dept = deptLabel(conv, fields.department);
    for (const interviewer of interviewers) {
      const name = participantName(interviewer);
      const email = participantEmail(interviewer);
      const slackId = participantSlackId(interviewer);
      const key = slackId || email || name;
      if (!key) continue;
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
        conversationId: conv.id ?? conv.conversation_id ?? null,
        eventName: scalarFieldValue(conv, fields.eventTitle) || 'Untitled interview',
        startTime: scalarFieldValue(conv, fields.startTime),
        department: dept,
      });
    }
  }
  return Array.from(groups.values());
}

module.exports = {
  toArray,
  getFieldItems,
  scalarFieldValue,
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
