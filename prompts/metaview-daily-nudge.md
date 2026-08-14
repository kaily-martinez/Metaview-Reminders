# Metaview Daily Nudge — runner prompt

You are running as a scheduled, non-interactive job (`claude -p` in headless
mode). Execute the steps below in order, using your Metaview and Slack MCP
tools plus the Bash tool to run the Node helper scripts in this repo. Do not
ask the user anything — make the documented default choice and proceed.
Run everything with the repo root (this file's parent's parent directory) as
your working directory.

## 0. Load config

Read `config.json`. You'll use `metaviewFields`, `departmentFieldId`,
`interviewConversationTypes`, and `testDmUserId` below. If `sitrepChannelId`
is empty, that's fine — it's not used by this script (only the weekly one).

## 1. Determine run mode

Run `echo "DRY_RUN=$DRY_RUN TEST_SELF=$TEST_SELF RUN_MODE=$RUN_MODE"` via Bash.

- `DRY_RUN=true` → **do not** call `slack_send_message` and **do not** write
  to `state/sit-rep-log.json`. Print exactly what would be sent, to whom, and
  why. This is the mode used for the multi-day review in the testing
  checklist.
- `TEST_SELF=true` → send every message to `testDmUserId` from config
  instead of the real interviewer's Slack ID, and prefix the message with
  `[TEST — would have gone to {{interviewer_name}}]\n\n`. Used for the
  one-time "check tone and formatting" test in the testing checklist. Still
  writes to the log normally unless `DRY_RUN` is also true.
- `RUN_MODE` — `today` (default, used for the normal 6pm weekday run) or
  `yesterday` (only needed if the schedule ever moves to a next-morning run).
  If unset, treat as `today`.

## 2. Compute the date window

Using the `timezone` from config.json, compute:

- `today`: `RUN_MODE=today` → start of the current local day through now.
  `RUN_MODE=yesterday` → start through end of the previous local day.

Get the current time via Bash (`date -u +%Y-%m-%dT%H:%M:%S.000Z`) and derive
the window's start/end as ISO-8601 UTC timestamps. Only the past matters
here — never include a window end in the future.

## 3. Query Metaview for the unrecorded bucket

Call `search_conversations` with:

```
only_show_recorded_conversations: false
filters: [
  {
    "field_id": "default:start_time",
    "operation": "between",
    "value": { "scope": "absolute", "value": ["<window_start_iso>", "<window_end_iso>"] }
  },
  {
    "field_id": "default:conversation_type",
    "operation": "is_one_of",
    "value": [ ...ids from config.json's interviewConversationTypes... ]
  }
]
fields: [
  "default:interviewer",
  "default:candidate",
  "default:calendar_event_title",
  "default:start_time",
  "default:conversation_type",
  "<departmentFieldId from config>"
]
limit: 200
```

If `total_count` suggests more than 200 rows for the window (unlikely for a
single day, but check), paginate with `offset` until you have them all.

This bucket mixes real missed candidate interviews with recurring internal
syncs that were never supposed to have a bot in them, plus internal
conversations (debriefs, vendor/leadership syncs) that can carry a
candidate participant despite not being an interview. Two independent
signals combine to catch both: the `conversation_type` filter above scopes
the query to real interview types (Job Interview / Coding Interview / System
Design Interview - see `interviewConversationTypes` in config.json), and the
Node runner below additionally requires a non-empty `default:candidate` list
in code (since that field can't be filtered server-side). Don't try to
replicate either filter yourself by reasoning over the JSON — let the query
and the runner do it deterministically.

Save the raw `conversations` array from the response.

## 4. Resolve Slack IDs for interviewers

Collect every unique interviewer email from the raw conversations (from each
`default:interviewer` entry). For any interviewer object that doesn't already
carry a `slack_id`, call `slack_search_users` with their email to resolve
their Slack user ID. Build a map `{ "email@company.com": "U123..." }` from
the resolved results. Skip (don't error on) anyone you can't find — they'll
show up in the runner's `unresolved` list and you'll report them at the end
instead of silently dropping them.

## 5. Run the daily runner

Write a JSON file (e.g. `/tmp/daily-input.json`) with this shape:

```json
{
  "conversations": [ ...raw conversations from step 3... ],
  "fields": {
    "interviewer": "default:interviewer",
    "candidate": "default:candidate",
    "eventTitle": "default:calendar_event_title",
    "startTime": "default:start_time",
    "department": "<departmentFieldId from config>",
    "conversationType": "default:conversation_type"
  },
  "allowedConversationTypeIds": [ ...ids from config.json's interviewConversationTypes... ],
  "slackIdMap": { ...from step 4... },
  "now": "<current ISO timestamp>",
  "timezone": "<timezone from config.json>"
}
```

Then run (from the repo root):

```
node bin/daily-runner.js < /tmp/daily-input.json > /tmp/daily-output.json
```

Read `/tmp/daily-output.json`. It contains `stats`, `messages` (one per
interviewer, already grouped and template-rendered — single-miss or
multi-miss template chosen automatically), and `unresolved` (interviewers
whose Slack ID couldn't be resolved).

## 6. Send (or print) the messages

For each entry in `messages`:

- If `DRY_RUN=true`: print `To: {{interviewerName}} ({{interviewerSlackId}})`
  followed by the message `text`. Do not call Slack. Do not log anything.
  Move on to the next entry.
- Otherwise: determine the target channel — `testDmUserId` from config if
  `TEST_SELF=true`, else the entry's `interviewerSlackId`. Call
  `slack_send_message` with `channel_id` = that target and `message` = the
  entry's `text` (prefixed with the `[TEST — ...]` line if `TEST_SELF=true`).
  Record the returned message `ts` — this is each entry's `messageTs`.

  For each of this message's `entries` (there may be several misses folded
  into one DM), set `messageTs` to the ts you just got back, `sentAt` to the
  current ISO timestamp, and `channelId` to the target you actually sent to
  (so replies can be read back later even in `TEST_SELF` mode).

## 7. Persist the log (skip entirely if `DRY_RUN=true`)

Collect every entry (across all sent messages) into one array and write it
to e.g. `/tmp/daily-log-entries.json` as `{ "entries": [...] }`, then run:

```
node bin/append-log.js state/sit-rep-log.json < /tmp/daily-log-entries.json
```

## 8. Report a summary

Print a short summary: how many raw conversations came back, how many
survived the real-candidate-interview filter, how many DMs were sent (or
would be sent, in dry-run), and list anyone in `unresolved` by name/email so
a human can add their Slack mapping. Do not print full message text again if
you already printed it in step 6.
