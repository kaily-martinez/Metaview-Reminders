# Metaview Weekly Sit-Rep — runner prompt

You are running as a scheduled, non-interactive job (`claude -p` in headless
mode), normally Monday mornings. Execute the steps below in order, using your
Metaview and Slack MCP tools plus the Bash tool to run the Node helper
scripts in this repo. Do not ask the user anything — make the documented
default choice and proceed. Run everything with the repo root (this file's
parent's parent directory) as your working directory.

## 0. Load config and state

Read `config.json` (`sitrepChannelId`, `canvasId`, `departmentFieldId`,
`metaviewFields`, `timezone`) and `state/sit-rep-log.json` (the full nudge
log) and `state/weekly-history.json` (an array of prior weeks' summaries,
oldest first: `{ weekStartISO, weekEndISO, scheduled, missed, missRate }`).

If `config.json`'s `sitrepChannelId` is empty, stop and report that the
Slack channel for the sit-rep hasn't been configured yet — do not guess a
channel.

## 1. Compute the week window

The reporting week is the 7 days ending **yesterday** (so a Monday run
covers the just-finished Mon–Sun week). Using `timezone` from config,
compute local calendar dates:

- `weekEndISO` = yesterday's date (`YYYY-MM-DD`)
- `weekStartISO` = 6 days before `weekEndISO`
- `trailingStartISO` = 27 days before `weekEndISO` (i.e. this week plus the
  3 weeks before it — a 4-week trailing window)

Get real current time via Bash (`date`) rather than guessing.

## 2. Pull this week's log entries and check for replies

From the full log, filter entries whose `startTime` falls within
`[weekStartISO, weekEndISO]` (inclusive, local calendar date) → these are
`weekLogEntries`. Also filter entries within `[trailingStartISO, weekEndISO]`
→ `trailing4WeeksLogEntries` (this naturally includes `weekLogEntries`).

For each entry in `weekLogEntries` that has a `channelId` and `messageTs`:
call `slack_read_thread` with `channel_id: entry.channelId`,
`message_ts: entry.messageTs`. Look at the replies (messages after the
parent, excluding the parent itself). If there's at least one reply from the
interviewer, take the earliest one's text as `rawReplyText` for that entry.
If there's no reply yet, set `rawReplyText` to `null`. Attach this
`rawReplyText` field onto each entry object in `weekLogEntries` (the Node
runner in step 4 will parse it against the a/b/c/d template — don't parse it
yourself).

## 3. Query Metaview for this week's recorded real interviews

Call `search_conversations` (default `only_show_recorded_conversations: true`,
i.e. omit that param or set it true) with:

```
filters: [
  {
    "field_id": "default:start_time",
    "operation": "between",
    "value": { "scope": "absolute", "value": ["<weekStart local midnight, ISO UTC>", "<weekEnd local end-of-day, ISO UTC>"] }
  }
]
fields: [
  "default:candidate",
  "<departmentFieldId from config>"
]
limit: 200
```

Paginate with `offset` if `total_count` exceeds 200. Save the raw
`conversations` array as `recordedConversations` — this, filtered for a
non-empty candidate list (done by the runner, not by you), is this week's
recorded real candidate interviews.

## 4. Run the weekly runner

Write a JSON file (e.g. `/tmp/weekly-input.json`):

```json
{
  "weekStartISO": "<weekStartISO>",
  "weekEndISO": "<weekEndISO>",
  "timestamp": "<current ISO timestamp>",
  "weekLogEntries": [ ...from step 2, each with rawReplyText attached... ],
  "trailing4WeeksLogEntries": [ ...from step 2... ],
  "recordedConversations": [ ...from step 3... ],
  "fields": { "candidate": "default:candidate", "department": "<departmentFieldId from config>" },
  "history": [ ...state/weekly-history.json content... ]
}
```

Then run:

```
node bin/weekly-runner.js < /tmp/weekly-input.json > /tmp/weekly-output.json
```

Read `/tmp/weekly-output.json`. It contains `canvasSections` (each canvas
section pre-rendered as markdown, including a `full` field with everything
joined), `updatedHistory` (last 5 weeks, ready to persist), and
`updatedLogEntries` (this week's log entries with `reason`/`replyRaw` now
resolved from `rawReplyText`).

## 5. Persist state

- Write `/tmp/weekly-log-entries.json` as `{ "entries": <updatedLogEntries> }`
  and run `node bin/append-log.js state/sit-rep-log.json < /tmp/weekly-log-entries.json`
  to write the parsed reply data back into the permanent log.
- Overwrite `state/weekly-history.json` with `updatedHistory` (pretty-printed
  JSON, trailing newline).

## 6. Create or update the Canvas

**First run ever** (`config.json`'s `canvasId` is `null`): call
`slack_create_canvas` in the channel from `sitrepChannelId`, with
`title: "🎥 Metaview Weekly Sit-Rep"` and `content` = `canvasSections.subtitle`
+ `canvasSections.glance` + `canvasSections.reasons` + `canvasSections.byTeam`
+ `canvasSections.repeatPattern` + `canvasSections.trend` +
`canvasSections.notesPlaceholder`, each joined by a blank line (do not
include `canvasSections.title` in `content` — the `title` param covers that).
Take the returned canvas ID and write it into `config.json`'s `canvasId`
field (edit the file directly).

**Every run after that**: call `slack_read_canvas` with the stored
`canvasId` to get the current section mapping. Match each returned section
to the heading/content it starts with, and build one `slack_update_canvas`
call with `edit_type: "replace"` for each of these six sections using the
freshly rendered content from `canvasSections`:

1. the subtitle line (starts with `**Week of`) → `canvasSections.subtitle`
2. `## This week at a glance` → `canvasSections.glance`
3. `## Breakdown by reason` → `canvasSections.reasons`
4. `## By team` → `canvasSections.byTeam`
5. `## Repeat pattern (trailing 4 weeks)` → `canvasSections.repeatPattern`
6. `## Trend (last 5 weeks)` → `canvasSections.trend`

**Do not touch the `## Notes` section or the title section.** Notes is a
manually-edited space for the team — clobbering it every Monday would defeat
its purpose. If for some reason one of the six sections above is missing
from the canvas (someone deleted it manually), append it back near where it
belongs rather than failing the whole run, and note that in your summary.

## 7. Report a summary

Print: interviews scheduled/missed/miss-rate for the week, the vs-last-week
trend, how many repeat-pattern people were flagged, and the canvas URL/link.
