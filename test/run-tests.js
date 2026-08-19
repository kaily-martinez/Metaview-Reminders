'use strict';
const assert = require('assert');
const { filterRealMisses, groupByInterviewer, firstName } = require('../lib/filters');
const { renderNudgeMessage } = require('../lib/templates');
const { parseReply, tallyReasons, missRate, trendArrow, byTeamRows, repeatOffenders } = require('../lib/aggregate');
const { renderReportSections } = require('../lib/report-render');
const { previousBusinessDayWindow, weekSoFarWindow, zonedMidnightToUTC } = require('../lib/schedule');
const { groupEntriesByInterviewer, renderOutreachReport } = require('../lib/outreach');
const { resolveFollowups } = require('../lib/followup');

const FIELDS = {
  interviewer: 'default:interviewer',
  candidate: 'default:candidate',
  eventTitle: 'default:calendar_event_title',
  startTime: 'default:start_time',
  department: 'OSPT:dept-field-id',
  conversationType: 'default:conversation_type',
  candidateApplication: 'default:candidate_application',
};

const JOB_INTERVIEW_TYPE_ID = '22eae796-087b-11ef-9815-5f761d7a35b3';
const CANDIDATE_DEBRIEF_TYPE_ID = '386f3400-087b-11ef-9816-335c9f345f49';

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

// Mirrors the real search_conversations shape: values nest under `fields`,
// and even scalar fields (title, start time, department) come back as
// [{ value, label }] lists. Participant fields carry a `details` object.
function row(id, fields) {
  return { id, fields };
}

function participant(name, email, slackId) {
  return { value: `uuid-${name}`, label: name, details: { name, emails: email ? [email] : [], phone_numbers: [] }, ...(slackId ? { slack_id: slackId } : {}) };
}

function scalar(value) {
  return [{ value, label: value }];
}

test('filterRealMisses drops a candidate-attached conversation whose type is not an allowed interview type', () => {
  // Mirrors real data: a "Candidate Debrief" (or vendor sync tagged "Other")
  // can carry a non-empty candidate list despite not being a real interview.
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Jim Saraco')],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
      [FIELDS.conversationType]: scalar(CANDIDATE_DEBRIEF_TYPE_ID),
    }),
    row(2, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - Sales Manager' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
      [FIELDS.conversationType]: scalar(JOB_INTERVIEW_TYPE_ID),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW, allowedConversationTypeIds: [JOB_INTERVIEW_TYPE_ID] });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 2);
});

test('filterRealMisses ignores conversationType allowlist when not provided (back-compat)', () => {
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Jim Saraco')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Jim Saraco - App' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
      [FIELDS.conversationType]: scalar(CANDIDATE_DEBRIEF_TYPE_ID),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 1);
});

test('filterRealMisses fails safe (drops everything) if conversation_type was never fetched but an allowlist is set', () => {
  // If the caller sets allowedConversationTypeIds but forgot to fetch/pass
  // default:conversation_type on the rows, there's no way to confirm a
  // match - so this must reject rather than silently let everything
  // through. Real conversations always include this field: this only
  // triggers on a caller mistake, and should surface as "0 misses found"
  // (loud) rather than "every miss included" (quietly wrong).
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
      // no conversationType field at all
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW, allowedConversationTypeIds: [JOB_INTERVIEW_TYPE_ID] });
  assert.strictEqual(result.length, 0);
});

test('filterRealMisses drops conversations with an empty candidate list', () => {
  const rows = [
    row(1, { [FIELDS.candidate]: [], [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00') }),
    row(2, {
      [FIELDS.candidate]: [participant('Alex Chen')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Alex Chen - App' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 2);
});

test('filterRealMisses drops a conversation with no linked ATS application (ad hoc, non-loop-scheduled booking)', () => {
  // Mirrors live data: "30 min with James (...)" and "Tamra <> Kiela : CS @ Luma Chat"
  // both had a real candidate but an empty default:candidate_application -
  // no job requisition link, i.e. not scheduled through Ashby.
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Saman Forouzandeh')],
      [FIELDS.candidateApplication]: [],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
    row(2, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - Sales Manager' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 2);
});

test('filterRealMisses ignores candidateApplication when not configured (back-compat)', () => {
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Saman Forouzandeh')],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
      // no candidateApplication field at all
    }),
  ];
  const fieldsWithoutApplication = { ...FIELDS, candidateApplication: undefined };
  const result = filterRealMisses(rows, fieldsWithoutApplication, { now: NOW });
  assert.strictEqual(result.length, 1);
});

test('filterRealMisses drops a conversation whose id is in excludeConversationIds (recorded despite only_show_recorded_conversations:false)', () => {
  // Live testing found only_show_recorded_conversations:false does not mean
  // "unrecorded only" - it returns recorded and unrecorded conversations
  // alike, so callers must separately fetch the recorded set for the same
  // window and exclude those ids here, or a normally-recorded interview
  // would incorrectly count as a miss.
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - App' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
    row(2, {
      [FIELDS.candidate]: [participant('Alex Chen')],
      [FIELDS.candidateApplication]: [{ value: 'app-2', label: 'Alex Chen - App' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW, excludeConversationIds: new Set([1]) });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 2);
});

test('filterRealMisses keeps everything when excludeConversationIds is not provided (back-compat)', () => {
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - App' }],
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 1);
});

test('filterRealMisses drops conversations whose event title matches an excluded pattern', () => {
  // Real data: one interviewer's whole miss count was almost entirely
  // "Meet & Greet" / "Meet and Greet" events, which carry the same
  // conversation_type and a real linked application as genuine interviews -
  // title is the only signal that distinguishes them.
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - App' }],
      [FIELDS.eventTitle]: scalar('Meet & Greet'),
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
    row(2, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - App' }],
      [FIELDS.eventTitle]: scalar('Meet and Greet'),
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
    row(3, {
      [FIELDS.candidate]: [participant('Alex Chen')],
      [FIELDS.candidateApplication]: [{ value: 'app-2', label: 'Alex Chen - App' }],
      [FIELDS.eventTitle]: scalar('Recruiter Screen'),
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW, excludedEventTitlePatterns: ['meet & greet', 'meet and greet'] });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 3);
});

test('filterRealMisses keeps everything when excludedEventTitlePatterns is not provided (back-compat)', () => {
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Ryan Pak')],
      [FIELDS.candidateApplication]: [{ value: 'app-1', label: 'Ryan Pak - App' }],
      [FIELDS.eventTitle]: scalar('Meet & Greet'),
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
    }),
  ];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 1);
});

test('filterRealMisses skips events that have not happened yet', () => {
  const rows = [row(1, { [FIELDS.candidate]: [participant('A')], [FIELDS.startTime]: scalar('2026-08-20 10:00:00-07:00') })];
  const result = filterRealMisses(rows, FIELDS, { now: NOW });
  assert.strictEqual(result.length, 0);
});

test('groupByInterviewer fans a multi-interviewer conversation into each group', () => {
  const rows = [
    row(1, {
      [FIELDS.candidate]: [participant('Alex Chen')],
      [FIELDS.interviewer]: [participant('Jane Doe', 'jane@co.com', 'U1'), participant('Sam Lee', 'sam@co.com')],
      [FIELDS.eventTitle]: scalar('Onsite: Alex Chen'),
      [FIELDS.startTime]: scalar('2026-08-13 10:00:00-07:00'),
      [FIELDS.department]: scalar('Engineering'),
    }),
  ];
  const groups = groupByInterviewer(rows, FIELDS);
  assert.strictEqual(groups.length, 2);
  const jane = groups.find((g) => g.interviewerName === 'Jane Doe');
  assert.strictEqual(jane.interviewerSlackId, 'U1');
  assert.strictEqual(jane.misses.length, 1);
});

test('groupByInterviewer combines multiple misses for the same person into one group', () => {
  const base = {
    [FIELDS.candidate]: [participant('X')],
    [FIELDS.interviewer]: [participant('Jane Doe', null, 'U1')],
    [FIELDS.department]: scalar('Eng'),
  };
  const rows = [
    row(1, { ...base, [FIELDS.eventTitle]: scalar('Interview A'), [FIELDS.startTime]: scalar('2026-08-11 10:00:00-07:00') }),
    row(2, { ...base, [FIELDS.eventTitle]: scalar('Interview B'), [FIELDS.startTime]: scalar('2026-08-12 14:00:00-07:00') }),
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
  assert.ok(msg.includes('a) Forgot to admit Metaview'));
});

test('renderNudgeMessage includes the candidate name in both templates when present', () => {
  const single = renderNudgeMessage({
    interviewerName: 'Jane Doe',
    misses: [{ eventName: 'Onsite', candidateName: 'Alex Chen', startTime: '2026-08-13T10:00:00-07:00' }],
  });
  assert.ok(single.includes('Onsite with Alex Chen'), `expected candidate name in:\n${single}`);

  const multi = renderNudgeMessage({
    interviewerName: 'Hakeem Saleh',
    misses: [
      { eventName: 'Recruiter Screen', candidateName: 'Sean Jaffe', startTime: '2026-08-14 20:30:00+00:00' },
      { eventName: 'Recruiter Screen', candidateName: 'Jennifer Jones', startTime: '2026-08-14 18:00:00+00:00' },
    ],
  });
  assert.ok(multi.includes('Recruiter Screen with Sean Jaffe'), `expected first candidate name in:\n${multi}`);
  assert.ok(multi.includes('Recruiter Screen with Jennifer Jones'), `expected second candidate name in:\n${multi}`);
});

test('renderNudgeMessage falls back gracefully when candidateName is missing', () => {
  const msg = renderNudgeMessage({
    interviewerName: 'Jane Doe',
    misses: [{ eventName: 'Onsite', startTime: '2026-08-13T10:00:00-07:00' }],
  });
  assert.ok(msg.includes('for Onsite on'), `should not print "with" when there is no candidate name:\n${msg}`);
  assert.ok(!msg.includes('with undefined') && !msg.includes('with null'));
});

test('renderNudgeMessage appends a timezone abbreviation next to times in the multi-miss template', () => {
  const msg = renderNudgeMessage(
    {
      interviewerName: 'Hakeem Saleh',
      misses: [
        { eventName: 'Recruiter Screen', candidateName: 'Sean Jaffe', startTime: '2026-08-14 20:30:00+00:00' },
        { eventName: 'Recruiter Screen', candidateName: 'Jennifer Jones', startTime: '2026-08-14 18:00:00+00:00' },
      ],
    },
    { timeZone: 'America/Los_Angeles' }
  );
  assert.ok(msg.includes('1:30 PM PDT'), `expected a timezone abbreviation next to the time in:\n${msg}`);
});

test('renderNudgeMessage omits the resource line when no resourceUrl is configured', () => {
  const group = { interviewerName: 'Jane Doe', misses: [{ eventName: 'Onsite: Alex Chen', startTime: '2026-08-13T10:00:00-07:00' }] };
  const msg = renderNudgeMessage(group);
  assert.ok(!msg.includes('Admit & Submit guide'));
});

test('renderNudgeMessage appends a resource line in both templates when resourceUrl is configured', () => {
  const url = 'https://example.com/metaview-guide';
  const single = renderNudgeMessage(
    { interviewerName: 'Jane Doe', misses: [{ eventName: 'Onsite: Alex Chen', startTime: '2026-08-13T10:00:00-07:00' }] },
    { resourceUrl: url }
  );
  assert.ok(single.includes(`[Admit & Submit guide](${url})`));
  assert.ok(single.indexOf('Admit & Submit guide') < single.indexOf('No stress'), 'resource line should come before the closing line');

  const multi = renderNudgeMessage(
    {
      interviewerName: 'Hakeem Saleh',
      misses: [
        { eventName: 'Recruiter Screen', startTime: '2026-08-14 20:30:00+00:00' },
        { eventName: 'Recruiter Screen', startTime: '2026-08-14 18:00:00+00:00' },
      ],
    },
    { resourceUrl: url }
  );
  assert.ok(multi.includes(`[Admit & Submit guide](${url})`));
});

test('renderNudgeMessage renders times in the configured company timezone, not the host machine timezone', () => {
  // 2026-08-14 20:30:00+00:00 is 1:30 PM Pacific (PDT, UTC-7), not 8:30 PM.
  const group = {
    interviewerName: 'Hakeem Saleh',
    misses: [
      { eventName: 'Recruiter Screen', startTime: '2026-08-14 20:30:00+00:00' },
      { eventName: 'Recruiter Screen', startTime: '2026-08-14 18:00:00+00:00' },
    ],
  };
  const msg = renderNudgeMessage(group, { timeZone: 'America/Los_Angeles' });
  assert.ok(msg.includes('1:30 PM'), `expected Pacific-time "1:30 PM" in:\n${msg}`);
  assert.ok(!msg.includes('8:30 PM'), `should not render raw UTC hour "8:30 PM" in:\n${msg}`);
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
  // a/b/c/d always listed one per line, never inlined into one sentence.
  assert.ok(msg.includes('a) Forgot to admit Metaview\nb) Tried to admit Metaview'));
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

test('renderReportSections produces all required sections as a plain message (no Canvas/Notes doc)', () => {
  const sections = renderReportSections({
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
  assert.ok(sections.notesInvite.includes('Reply in this thread'));
  assert.ok(sections.full.includes('## Repeat pattern'));
});

test('zonedMidnightToUTC finds the correct UTC instant for local midnight', () => {
  // Aug 14 2026 is PDT (UTC-7), so Pacific midnight is 07:00 UTC.
  assert.strictEqual(zonedMidnightToUTC(2026, 8, 14, 'America/Los_Angeles').toISOString(), '2026-08-14T07:00:00.000Z');
});

test('previousBusinessDayWindow rolls a Monday run back to the preceding Friday', () => {
  const monday9am = new Date('2026-08-17T16:00:00.000Z'); // Mon Aug 17, 9am PDT
  const result = previousBusinessDayWindow(monday9am, 'America/Los_Angeles');
  assert.strictEqual(result.dateLabel, '2026-08-14'); // Friday
  assert.strictEqual(result.startISO, '2026-08-14T07:00:00.000Z');
  assert.strictEqual(result.endISO, '2026-08-15T07:00:00.000Z');
});

test('previousBusinessDayWindow uses the prior calendar day on Tue-Fri', () => {
  const tuesday9am = new Date('2026-08-18T16:00:00.000Z'); // Tue Aug 18, 9am PDT
  const result = previousBusinessDayWindow(tuesday9am, 'America/Los_Angeles');
  assert.strictEqual(result.dateLabel, '2026-08-17'); // Monday
});

test('previousBusinessDayWindow rolls weekend manual runs back to Friday too', () => {
  const saturday = new Date('2026-08-15T16:00:00.000Z');
  const sunday = new Date('2026-08-16T16:00:00.000Z');
  assert.strictEqual(previousBusinessDayWindow(saturday, 'America/Los_Angeles').dateLabel, '2026-08-14');
  assert.strictEqual(previousBusinessDayWindow(sunday, 'America/Los_Angeles').dateLabel, '2026-08-14');
});

test('weekSoFarWindow starts at Monday of the current week', () => {
  const friday10am = new Date('2026-08-14T17:00:00.000Z'); // Fri Aug 14, 10am PDT
  const result = weekSoFarWindow(friday10am, 'America/Los_Angeles');
  assert.strictEqual(result.weekStartDateLabel, '2026-08-10'); // Monday of that week
  assert.strictEqual(result.endISO, friday10am.toISOString());
});

test('groupEntriesByInterviewer groups and sorts busiest-first', () => {
  const entries = [
    { interviewerName: 'Sam Lee', interviewerSlackId: 'U2', eventName: 'HM Screen' },
    { interviewerName: 'Jane Doe', interviewerSlackId: 'U1', eventName: 'Recruiter Screen' },
    { interviewerName: 'Jane Doe', interviewerSlackId: 'U1', eventName: 'Onsite' },
  ];
  const groups = groupEntriesByInterviewer(entries);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].interviewerName, 'Jane Doe');
  assert.strictEqual(groups[0].entries.length, 2);
  assert.strictEqual(groups[1].interviewerName, 'Sam Lee');
});

test('renderOutreachReport lists single and combined misses per interviewer', () => {
  const entries = [
    { interviewerName: 'Jane Doe', interviewerSlackId: 'U1', eventName: 'Recruiter Screen', date: 'Aug 11' },
    { interviewerName: 'Jane Doe', interviewerSlackId: 'U1', eventName: 'Onsite', date: 'Aug 12' },
    { interviewerName: 'Sam Lee', interviewerSlackId: 'U2', eventName: 'HM Screen', date: 'Aug 13' },
  ];
  const text = renderOutreachReport(entries, { weekStartLabel: 'Aug 10', weekEndLabel: 'Aug 14' });
  assert.ok(text.includes('3 misses across 2 interviewers'));
  assert.ok(text.includes('*Jane Doe* — 2 misses: Recruiter Screen (Aug 11), Onsite (Aug 12)'));
  assert.ok(text.includes('*Sam Lee* — HM Screen (Aug 13)'));
});

test('renderOutreachReport handles a dry week gracefully', () => {
  const text = renderOutreachReport([], { weekStartLabel: 'Aug 10', weekEndLabel: 'Aug 14' });
  assert.ok(text.includes('No misses logged yet this week'));
});

const REASON_FOLLOWUPS = {
  a: 'Reminder: please admit Metaview every time it asks to join.',
  b: 'Try adding notes@bot.metaview.ai as a guest on the meeting.',
  c: 'Thanks for confirming — flag it to RecOps if notes still never show up.',
};

test('resolveFollowups queues a follow-up and resolves reason/replyRaw for a clean a/b/c reply', () => {
  const entries = [
    { id: '1', interviewerSlackId: 'U1', channelId: 'U1', messageTs: '100.1', reason: null, replyRaw: null, rawReplyText: 'b) tried but it didn\'t work' },
  ];
  const { updatedEntries, followups } = resolveFollowups(entries, REASON_FOLLOWUPS, { now: '2026-08-14T16:00:00.000Z' });
  assert.strictEqual(updatedEntries.length, 1);
  assert.strictEqual(updatedEntries[0].reason, 'b');
  assert.strictEqual(updatedEntries[0].replyRaw, "b) tried but it didn't work");
  assert.strictEqual(updatedEntries[0].followupSentAt, '2026-08-14T16:00:00.000Z');
  assert.ok(!('rawReplyText' in updatedEntries[0]));
  assert.strictEqual(followups.length, 1);
  assert.deepStrictEqual(followups[0], {
    interviewerSlackId: 'U1',
    channelId: 'U1',
    messageTs: '100.1',
    reason: 'b',
    text: REASON_FOLLOWUPS.b,
    replyIsThreaded: true,
  });
});

test('resolveFollowups mirrors a plain (non-threaded) reply with a plain follow-up', () => {
  const entries = [
    { id: '1b', interviewerSlackId: 'U1', channelId: 'U1', messageTs: '100.1', reason: null, replyRaw: null, rawReplyText: 'a) forgot', replyIsThreaded: false },
  ];
  const { updatedEntries, followups } = resolveFollowups(entries, REASON_FOLLOWUPS);
  assert.ok(!('replyIsThreaded' in updatedEntries[0]));
  assert.strictEqual(followups[0].replyIsThreaded, false);
});

test('resolveFollowups defaults to a threaded follow-up when replyIsThreaded is unset', () => {
  const entries = [
    { id: '1c', interviewerSlackId: 'U1', channelId: 'U1', messageTs: '100.1', reason: null, replyRaw: null, rawReplyText: 'a) forgot' },
  ];
  const { followups } = resolveFollowups(entries, REASON_FOLLOWUPS);
  assert.strictEqual(followups[0].replyIsThreaded, true);
});

test('resolveFollowups resolves a reason with no configured text but queues nothing', () => {
  const entries = [
    { id: '2', interviewerSlackId: 'U2', channelId: 'U2', messageTs: '100.2', reason: null, replyRaw: null, rawReplyText: 'd) something else entirely' },
  ];
  const { updatedEntries, followups } = resolveFollowups(entries, REASON_FOLLOWUPS);
  assert.strictEqual(updatedEntries[0].reason, 'd');
  assert.strictEqual(updatedEntries[0].followupSentAt, undefined);
  assert.strictEqual(followups.length, 0);
});

test('resolveFollowups skips an entry that already got a follow-up, even with new reply text', () => {
  const entries = [
    { id: '3', interviewerSlackId: 'U3', channelId: 'U3', messageTs: '100.3', reason: 'a', replyRaw: 'a', followupSentAt: '2026-08-13T09:00:00.000Z', rawReplyText: 'actually b now' },
  ];
  const { updatedEntries, followups } = resolveFollowups(entries, REASON_FOLLOWUPS);
  assert.strictEqual(updatedEntries.length, 1);
  assert.strictEqual(updatedEntries[0], entries[0]);
  assert.strictEqual(followups.length, 0);
});

test('resolveFollowups passes through an entry with no reply yet, untouched', () => {
  const entries = [
    { id: '4', interviewerSlackId: 'U4', channelId: 'U4', messageTs: '100.4', reason: null, replyRaw: null, rawReplyText: null },
  ];
  const { updatedEntries, followups } = resolveFollowups(entries, REASON_FOLLOWUPS);
  assert.strictEqual(updatedEntries.length, 1);
  assert.strictEqual(updatedEntries[0], entries[0]);
  assert.strictEqual(followups.length, 0);
});

test('resolveFollowups treats an unparseable reply as "other" with no follow-up', () => {
  const entries = [
    { id: '5', interviewerSlackId: 'U5', channelId: 'U5', messageTs: '100.5', reason: null, replyRaw: null, rawReplyText: 'not sure, will check' },
  ];
  const { updatedEntries, followups } = resolveFollowups(entries, REASON_FOLLOWUPS);
  assert.strictEqual(updatedEntries[0].reason, 'other');
  assert.strictEqual(updatedEntries[0].replyRaw, 'not sure, will check');
  assert.strictEqual(followups.length, 0);
});

console.log(`\n${passed} test(s) passed`);
if (process.exitCode) {
  console.error('Some tests failed.');
  process.exit(process.exitCode);
}
