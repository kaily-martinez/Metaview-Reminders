'use strict';

function fmtPct(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Renders the weekly sit-rep as a plain Slack message (posted fresh each
 * week, not an editable document) - see lib/aggregate.js for the numbers
 * that feed this. Sections are still returned individually in case a
 * caller wants just one, but `full` is what actually gets posted.
 */
function renderReportSections(data) {
  const {
    weekStart,
    weekEnd,
    timestamp,
    scheduled,
    missed,
    missRate,
    lastWeekRate,
    trendArrow,
    reasonBreakdown,
    byTeam,
    repeatOffenders,
    trend,
  } = data;

  const title = '# 🎥 Metaview Weekly Sit-Rep';

  const subtitle = `**Week of ${weekStart} – ${weekEnd}** · Posted ${timestamp}`;

  const glance = `## This week at a glance
| Metric | Value |
|---|---|
| Interviews scheduled | ${scheduled} |
| Missed by Metaview | ${missed} |
| Miss rate | ${fmtPct(missRate)}% |
| vs. last week | ${trendArrow} from ${fmtPct(lastWeekRate)}% |`;

  const reasonRows = reasonBreakdown.map((r) => `| ${r.reason} | ${r.count} | ${fmtPct(r.pct)}% |`).join('\n');
  const reasons = `## Breakdown by reason
| Reason | Count | Share |
|---|---|---|
${reasonRows}`;

  const teamRows = byTeam.length
    ? byTeam.map((t) => `| ${t.team} | ${t.missed} | ${t.scheduled} | ${fmtPct(t.missRate)}% |`).join('\n')
    : '| _no data_ | 0 | 0 | 0% |';
  const byTeamSection = `## By team
| Team | Misses | Scheduled | Miss rate |
|---|---|---|---|
${teamRows}`;

  const repeatRows = repeatOffenders.length
    ? repeatOffenders.map((p) => `- **${p.name}** — ${p.count} misses (reasons: ${p.breakdown})`).join('\n')
    : '- No repeat misses in the trailing 4 weeks 🎉';
  const repeatPattern = `## Repeat pattern (trailing 4 weeks)
_Framed as a heads-up, not a callout — for context in 1:1s, not public shaming._
${repeatRows}`;

  const trendRows = trend.map((t) => `| ${t.weekStart} | ${fmtPct(t.missRate)}% |`).join('\n');
  const trendSection = `## Trend (last 5 weeks)
| Week of | Miss rate |
|---|---|
${trendRows}`;

  // No persistent "Notes" section to preserve - this is a fresh message each
  // week, not an editable document. Manual commentary naturally goes as a
  // thread reply instead.
  const notesInvite = `_Anything worth flagging? Reply in this thread._`;

  const full = [title, subtitle, glance, reasons, byTeamSection, repeatPattern, trendSection, notesInvite].join('\n\n');

  return {
    title,
    subtitle,
    glance,
    reasons,
    byTeam: byTeamSection,
    repeatPattern,
    trend: trendSection,
    notesInvite,
    full,
  };
}

module.exports = { renderReportSections, fmtPct };
