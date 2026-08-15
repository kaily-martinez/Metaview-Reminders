#!/usr/bin/env node
'use strict';

/**
 * Resolves fresh Slack replies (fetched live by the calling prompt via
 * slack_read_channel / slack_read_thread) into a/b/c/d reason codes, and
 * queues any configured follow-up text - e.g. the notes@metaview.ai guest
 * tip for a "b) tried but didn't work" reply. Runs as part of the daily
 * job so a follow-up lands the same day someone replies.
 *
 * Usage: node bin/followup-runner.js < input.json > output.json
 *
 * Input JSON shape:
 * {
 *   "entries": [ <unresolved log entries, each with rawReplyText attached> ],
 *   "reasonFollowups": { "a": "...", "b": "...", "c": "..." },
 *   "now": "2026-08-14T16:00:00.000Z"
 * }
 */

const { resolveFollowups } = require('../lib/followup');

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
  const entries = input.entries || [];
  const reasonFollowups = input.reasonFollowups || {};
  const now = input.now || null;

  const { updatedEntries, followups } = resolveFollowups(entries, reasonFollowups, { now });

  process.stdout.write(JSON.stringify({ updatedEntries, followups }, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
