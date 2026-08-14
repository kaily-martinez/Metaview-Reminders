'use strict';
const assert = require('assert');
const { filterRealMisses, groupByInterviewer, firstName } = require('../lib/filters');
const { renderNudgeMessage } = require('../lib/templates');
const { parseReply, tallyReasons, missRate, trendArrow, byTeamRows, repeatOffenders } = require('../lib/aggregate');
const { renderCanvasSections } = require('../lib/canvas-render');

const FIELDS = {
  interviewer: 'default:interviewer',
  candidate: 'default:candidate',
  eventTitle: 'default:calendar_event_title',
  startTime: 'default:start_time',
  department: 'OSPT:dept-field-id',
};

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const NOW = new Date('2026-08-14T12:00:00-07:00');

test('filterRealMisses drops conversations with an empty candidate list', () => {
  const rows = [
    { conversation_id: 1, [FIELDS.candidate]: [], [FIELDS.startTime]: '2026-08-13T10:00:00-07:00' },
    { conversation_id: 2, [FIELDS.candidate]: [{ name: 'Alex Chen' }], [FIELDS.startTime]: '2026-08-13T10:00:00-07:00' },
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].conversation_id, 2);
});

test('filterRealMisses skips events that have not happened yet', () => {
  const rows = [
    { conversation_id: 1, [FIELDS.candidate]: [{ name: 'A' }], [FIELDS.startTime]: '2026-08-20T10:00:00-07:00' },
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 0);
});

test('groupByInterviewer fans a multi-interviewer conversation into each group', () => {
  const rows = [
    {
      conversation_id: 1,
      [FIELDS.candidate]: [{ name: 'Alex Chen' }],
      [FIELDS.interviewer]: [
        { name: 'Jane Doe', email: 'jane@co.com', slack_id: 'U1' },
        { name: 'Sam Lee', email: 'sam@co.com' },
      ],
      [FIELDS.eventTitle]: 'Onsite: Alex Chen',
      [FIELDS.startTime]: '2026-08-13T10:00:00-07:00',
      [FIELDS.department]: 'Engineering',
    },
  ];
  const groups = groupByInterviewer(rows, FIELDS);
  assert.strictEqual(groups.length, 2);
  const jane = groups.find((g) => g.interviewerName === 'Jane Doe');
  assert.strictEqual(jane.interviewerSlackId, 'U1');
  assert.strictEqual(jane.misses.length, 1);
});

test('groupByInterviewer combines multiple misses for the same person into one group', () => {
  const base = {
    [FIELDS.candidate]: [{ name: 'X' }],
    [FIELDS.interviewer]: [{ name: 'Jane Doe', slack_id: 'U1' }],
    [FIELDS.department]: 'Eng',
  };
  const rows = [
    { ...base, conversation_id: 1, [FIELDS.eventTitle]: 'Interview A', [FIELDS.startTime]: '2026-08-11T10:00:00-07:00' },
    { ...base, conversation_id: 2, [FIELDS.eventTitle]: 'Interview B', [FIELDS.startTime]: '2026-08-12T14:00:00-07:00' },
  ];
  const groups = groupByInterviewer(rows, FIELDS);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].misses.length, 2);
});

test('firstName extracts the first token', () => {
  assert.strictEqual(firstName('Jane Doe'), 'Jane');
  assert.strictEqual(firstName(null), 'there');
});

test('renderNudgeMessage uses the single-miss template for one miss', () => {
  const group = { interviewerName: 'Jane Doe', misses: [{ eventName: 'Onsite: Alex Chen', startTime: '2026-08-13T10:00:00-07:00' }] };
  const msg = renderNudgeMessage(group);
  assert.ok(msg.includes('Hey Jane —'));
  assert.ok(msg.includes('Onsite: Alex Chen'));
  assert.ok(msg.includes('a) Forgot to admit it when it asked to join'));
});

test('renderNudgeMessage uses the multi-miss template for 2+ misses', () => {
  const group = {
    interviewerName: 'Jane Doe',
    misses: [
      { eventName: 'Interview A', startTime: '2026-08-11T10:00:00-07:00' },
      { eventName: 'Interview B', startTime: '2026-08-12T14:00:00-07:00' },
    ],
  };
  const msg = renderNudgeMessage(group);
  assert.ok(msg.includes("wasn't able to join a couple of your calls"));
  assert.ok(msg.includes('• Interview A'));
  assert.ok(msg.includes('• Interview B'));
});

test('parseReply matches a/b/c/d with common separators', () => {
  assert.strictEqual(parseReply('a) forgot to admit it').code, 'a');
  assert.strictEqual(parseReply('B').code, 'b');
  assert.strictEqual(parseReply('c. joined fine').code, 'c');
  assert.strictEqual(parseReply('d - laptop died').code, 'd');
});

test('parseReply treats non-matching text as other/free-text', () => {
  const r = parseReply('actually it was a scheduling conflict, sorry!');
  assert.strictEqual(r.code, null);
  assert.strictEqual(r.isOther, true);
});

test('parseReply treats no reply as null/null', () => {
  const r = parseReply(null);
  assert.strictEqual(r.code, null);
  assert.strictEqual(r.raw, null);
});

test('tallyReasons counts a/b/c/d/no-reply/other correctly with percentages', () => {
  const entries = [
    { reason: 'a', replyRaw: 'a) forgot' },
    { reason: 'a', replyRaw: 'a) forgot again' },
    { reason: 'b', replyRaw: 'b) tried' },
    { reason: null, replyRaw: null },
  ];
  const tally = tallyReasons(entries);
  assert.strictEqual(tally.total, 4);
  assert.strictEqual(tally.counts.a, 2);
  assert.strictEqual(tally.counts.b, 1);
  assert.strictEqual(tally.counts.noReply, 1);
  const aRow = tally.breakdown.find((b) => b.key === 'a');
  assert.strictEqual(aRow.pct, 50);
});

test('missRate handles zero scheduled without dividing by zero', () => {
  assert.strictEqual(missRate(0, 0), 0);
  assert.strictEqual(missRate(1, 4), 25);
});

test('trendArrow reflects direction vs. prior week', () => {
  assert.strictEqual(trendArrow(10, 20), '↓');
  assert.strictEqual(trendArrow(20, 10), '↑');
  assert.strictEqual(trendArrow(10, 10), '→');
  assert.strictEqual(trendArrow(10, null), '→');
});

test('byTeamRows folds misses into their team scheduled denominator', () => {
  const recorded = [{ dept: 'Eng' }, { dept: 'Eng' }, { dept: 'Sales' }];
  const missed = [{ dept: 'Eng' }];
  const rows = byTeamRows(recorded, missed, (r) => r.dept, (m) => m.dept);
  const eng = rows.find((r) => r.team === 'Eng');
  assert.strictEqual(eng.scheduled, 3);
  assert.strictEqual(eng.missed, 1);
  assert.strictEqual(eng.missRate, missRate(1, 3));
});

test('repeatOffenders only surfaces people with 2+ misses in the trailing window', () => {
  const entries = [
    { interviewerName: 'Jane Doe', interviewerSlackId: 'U1', reason: 'a', replyRaw: 'a' },
    { interviewerName: 'Jane Doe', interviewerSlackId: 'U1', reason: 'b', replyRaw: 'b' },
    { interviewerName: 'Sam Lee', interviewerSlackId: 'U2', reason: 'a', replyRaw: 'a' },
  ];
  const offenders = repeatOffenders(entries);
  assert.strictEqual(offenders.length, 1);
  assert.strictEqual(offenders[0].name, 'Jane Doe');
  assert.strictEqual(offenders[0].count, 2);
});

test('renderCanvasSections produces all required sections and preserves a Notes placeholder', () => {
  const sections = renderCanvasSections({
    weekStart: 'Aug 10',
    weekEnd: 'Aug 16',
    timestamp: 'Aug 17, 8:00 AM',
    scheduled: 20,
    missed: 3,
    missRate: 15,
    lastWeekRate: 20,
    trendArrow: '↓',
    reasonBreakdown: [
      { reason: 'Forgot to admit', count: 2, pct: 66.7 },
      { reason: "Tried, didn't work", count: 0, pct: 0 },
      { reason: 'Actually joined fine (false positive)', count: 0, pct: 0 },
      { reason: 'No reply yet', count: 1, pct: 33.3 },
    ],
    byTeam: [{ team: 'Engineering', missed: 2, scheduled: 10, missRate: 20 }],
    repeatOffenders: [{ name: 'Jane Doe', count: 2, breakdown: '2 forgot to admit' }],
    trend: [{ weekStart: 'Aug 10', missRate: 15 }],
  });
  assert.ok(sections.title.includes('Metaview Weekly Sit-Rep'));
  assert.ok(sections.subtitle.includes('Aug 10'));
  assert.ok(sections.glance.includes('| Interviews scheduled | 20 |'));
  assert.ok(sections.notesPlaceholder.includes('## Notes'));
  assert.ok(sections.full.includes('## Repeat pattern'));
});

console.log(`\n${passed} test(s) passed`);
if (process.exitCode) {
  console.error('Some tests failed.');
  process.exit(process.exitCode);
}
