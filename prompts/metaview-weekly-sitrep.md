# Metaview Weekly Sit-Rep — runner prompt

You are running as a scheduled, non-interactive job (`claude -p` in headless
mode), normally Monday mornings. Execute the steps below in order, using your
Metaview and Slack MCP tools plus the Bash tool to run the Node helper
scripts in this repo. Do not ask the user anything — make the documented
default choice and proceed. Run everything with the repo root (this file's
parent's parent directory) as your working directory.

## 0. Load config and state

Read `config.json` (`sitrepChannelId`, `departmentFieldId`, `metaviewFields`,
`interviewConversationTypes`, `timezone`) and `state/sit-rep-log.json` (the
full nudge log) and `state/weekly-history.json` (an array of prior weeks'
summaries, oldest first: `{ weekStartISO, weekEndISO, scheduled, missed,
missRate }`).

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
  },
  {
    "field_id": "default:conversation_type",
    "operation": "is_one_of",
    "value": [ ...ids from config.json's interviewConversationTypes... ]
  }
]
fields: [
  "default:candidate",
  "default:conversation_type",
  "default:candidate_application",
  "<departmentFieldId from config>"
]
limit: 200
```

Paginate with `offset` if `total_count` exceeds 200. Save the raw
`conversations` array as `recordedConversations` — this, filtered for a
non-empty candidate list, an allowed conversation_type, and a linked ATS
application (all done by the runner, not by you), is this week's recorded
real candidate interviews. Using the same filters here as in the daily job
keeps "scheduled" and "missed" counting the same thing.

**Important**: `default:conversation_type` and `default:candidate_application`
must stay in the `fields` list above whenever `allowedConversationTypeIds`
is passed to the runner in step 4 — if the runner can't see a
conversation's type, it fails safe and drops that conversation rather than
guessing, so a missing field here silently zeroes out `recordedConversations`
instead of loudly erring.

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
  "fields": {
    "candidate": "default:candidate",
    "department": "<departmentFieldId from config>",
    "conversationType": "default:conversation_type",
    "candidateApplication": "default:candidate_application"
  },
  "allowedConversationTypeIds": [ ...ids from config.json's interviewConversationTypes... ],
  "history": [ ...state/weekly-history.json content... ],
  "timezone": "<timezone from config.json>"
}
```

Then run:

```
node bin/weekly-runner.js < /tmp/weekly-input.json > /tmp/weekly-output.json
```

Read `/tmp/weekly-output.json`. It contains `reportSections` (each section
pre-rendered as markdown, including a `full` field with everything joined —
this is the whole message text), `updatedHistory` (last 5 weeks, ready to
persist), and `updatedLogEntries` (this week's log entries with
`reason`/`replyRaw` now resolved from `rawReplyText`).

## 5. Persist state

- Write `/tmp/weekly-log-entries.json` as `{ "entries": <updatedLogEntries> }`
  and run `node bin/append-log.js state/sit-rep-log.json < /tmp/weekly-log-entries.json`
  to write the parsed reply data back into the permanent log.
- Overwrite `state/weekly-history.json` with `updatedHistory` (pretty-printed
  JSON, trailing newline).

## 6. Post the report

Call `slack_send_message` with `channel_id` = `sitrepChannelId` from config
and `message` = `reportSections.full`. This is a plain channel message
posted fresh each week — not a Canvas, so there's no create-vs-update
distinction and nothing to preserve between runs. Manual commentary from the
team belongs as a thread reply on that message (the report text invites
this), not as an edited section, so there's no "Notes" state to manage here.

## 7. Report a summary

Print: interviews scheduled/missed/miss-rate for the week, the vs-last-week
trend, how many repeat-pattern people were flagged, and the Slack message
link.
