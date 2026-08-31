'use strict';

const { parseReply } = require('./aggregate');

/**
 * Resolves fresh Slack replies on unresolved nudges into a/b/c/d/e reason
 * codes and queues any configured follow-up text. Runs daily (not weekly)
 * so a follow-up lands promptly after someone replies, rather than up to a
 * week later. Entries with no new reply, or that already got a follow-up,
 * pass through unchanged with nothing queued - callers should only pass in
 * entries that look unresolved (see prompts/metaview-daily-nudge.md step 3).
 */
function resolveFollowups(entries, reasonFollowups = {}, { now } = {}) {
  const timestamp = now || new Date().toISOString();
  const updatedEntries = [];
  const followups = [];

  for (const entry of entries) {
    const { rawReplyText, replyIsThreaded, ...rest } = entry;

    if (entry.followupSentAt || rawReplyText == null) {
      updatedEntries.push(entry);
      continue;
    }

    const { code, isOther, raw } = parseReply(rawReplyText);
    const reason = isOther ? 'other' : code;
    const updated = { ...rest, reason, replyRaw: raw };

    const text = reason ? reasonFollowups[reason] : null;
    if (text) {
      followups.push({
        interviewerSlackId: entry.interviewerSlackId,
        channelId: entry.channelId,
        messageTs: entry.messageTs,
        reason,
        text,
        // Mirror how the person replied: a threaded reply gets a threaded
        // follow-up, a plain DM reply gets a plain follow-up. Defaults to
        // threaded (the safer, always-visible-on-the-nudge choice) if a
        // caller doesn't say which kind of reply it found.
        replyIsThreaded: replyIsThreaded !== false,
      });
      updated.followupSentAt = timestamp;
    }

    updatedEntries.push(updated);
  }

  return { updatedEntries, followups };
}

module.exports = { resolveFollowups };
