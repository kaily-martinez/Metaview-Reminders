#!/usr/bin/env node
'use strict';

/**
 * Appends/upserts completed log entries (with messageTs + sentAt filled in
 * after the calling prompt actually sent each Slack DM) into
 * state/sit-rep-log.json.
 *
 * Usage: node bin/append-log.js [path-to-log-json] < input.json
 * Input JSON shape: { "entries": [ <log entry objects> ] }
 * Prints the total entry count after the merge.
 */

const path = require('path');
const { upsertEntries } = require('../lib/log-store');

function readStdin() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  return new Promise((resolve, reject) => {
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const logPath = process.argv[2] || path.join(__dirname, '..', 'state', 'sit-rep-log.json');
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}');
  const entries = input.entries || [];
  const merged = upsertEntries(logPath, entries);
  process.stdout.write(JSON.stringify({ appended: entries.length, totalEntries: merged.length, logPath }, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
