'use strict';
const fs = require('fs');
const path = require('path');

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8').trim();
  if (!raw) return [];
  return JSON.parse(raw);
}

function writeLog(logPath, entries) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(entries, null, 2) + '\n');
}

/** Appends new entries, or upserts existing ones by id (used when the weekly script writes back parsed reply data). */
function upsertEntries(logPath, entries) {
  const existing = readLog(logPath);
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const entry of entries) {
    byId.set(entry.id, { ...byId.get(entry.id), ...entry });
  }
  const merged = Array.from(byId.values());
  writeLog(logPath, merged);
  return merged;
}

module.exports = { readLog, writeLog, upsertEntries };
