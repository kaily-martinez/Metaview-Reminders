#!/usr/bin/env node
'use strict';

/**
 * Daily nudge CLI runner.
 *
 * Bridges raw Metaview rows (fetched live via MCP by the prompt driving this)
 * to rendered Slack DM text + log-entry skeletons. Does no network I/O
 * itself - the calling prompt handles Slack user-id resolution and actually
 * sending messages, then fills in messageTs/sentAt before persisting via
 * bin/append-log.js.
 *
 * Usage: node bin/daily-runner.js < input.json > output.json
 *
 * Input JSON shape:
 * {
 *   "conversations": [ <raw Metaview search_conversations rows> ],
 *   "fields": { "interviewer": "default:interviewer", "candidate": "default:candidate",
 *               "eventTitle": "default:calendar_event_title", "startTime": "default:start_time",
 *               "department": "OSPT:<field-id>",      // optional
 *               "conversationType": "default:conversation_type",  // optional, needed for allowedConversationTypeIds below
 *               "candidateApplication": "default:candidate_application" },  // optional - if set, excludes conversations with no linked ATS application (ad hoc/non-loop-scheduled bookings)
 *   "allowedConversationTypeIds": ["<uuid>", ...],     // optional - if set, only these conversation_type values count as real interviews
 *   "slackIdMap": { "jane@co.com": "U123..." },        // email -> resolved Slack user id
 *   "now": "2026-08-14T18:00:00-07:00",                // optional, defaults to real now
 *   "timezone": "America/Los_Angeles",                 // IANA zone for displayed dates/times; defaults to America/Los_Angeles
 *   "resourceUrl": "https://..."                       // optional - if set, appends a short "how admit works" pointer to the DM
 * }
 */

const { filterRealMisses, groupByInterviewer, firstName } = require('../lib/filters');
const { renderNudgeMessage, formatDate } = require('../lib/templates');

function readStdin() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  return new Promise((resolve, reject) => {
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}');
  const conversations = input.conversations || [];
  const fields = Object.assign(
    {
      interviewer: 'default:interviewer',
      candidate: 'default:candidate',
      eventTitle: 'default:calendar_event_title',
      startTime: 'default:start_time',
      department: null,
      conversationType: null,
      candidateApplication: null,
    },
    input.fields || {}
  );
  const slackIdMap = input.slackIdMap || {};
  const now = input.now ? new Date(input.now) : new Date();
  const timeZone = input.timezone || 'America/Los_Angeles';
  const allowedConversationTypeIds = input.allowedConversationTypeIds || null;
  const resourceUrl = input.resourceUrl || null;

  const misses = filterRealMisses(conversations, fields, { now, allowedConversationTypeIds });
  const groups = groupByInterviewer(misses, fields);

  const messages = [];
  const unresolved = [];

  for (const group of groups) {
    const slackId = group.interviewerSlackId || (group.interviewerEmail && slackIdMap[group.interviewerEmail]) || null;
    if (!slackId) {
      unresolved.push({
        interviewerName: group.interviewerName,
        interviewerEmail: group.interviewerEmail,
        missCount: group.misses.length,
      });
      continue;
    }

    const text = renderNudgeMessage({ interviewerName: group.interviewerName, misses: group.misses }, { timeZone, resourceUrl });

    const entries = group.misses.map((m) => ({
      id: `${m.conversationId ?? slugify(m.eventName)}-${slugify(slackId)}`,
      conversationId: m.conversationId,
      interviewerName: group.interviewerName,
      interviewerSlackId: slackId,
      department: m.department || group.department || null,
      eventName: m.eventName,
      startTime: m.startTime,
      date: formatDate(m.startTime, timeZone),
      channelId: slackId,
      messageTs: null,
      sentAt: null,
      reason: null,
      replyRaw: null,
    }));

    messages.push({
      interviewerName: group.interviewerName,
      interviewerSlackId: slackId,
      firstName: firstName(group.interviewerName),
      channelId: slackId,
      text,
      entries,
    });
  }

  const output = {
    stats: {
      totalFetched: conversations.length,
      afterNoiseFilter: misses.length,
      groupCount: groups.length,
      messageCount: messages.length,
      unresolvedCount: unresolved.length,
    },
    messages,
    unresolved,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
