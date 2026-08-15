# Metaview Daily Nudge — runner prompt

Runs weekdays at 9am, checking the previous business day's interviews (a
Monday run checks Friday, since the job doesn't run over the weekend).

You are running as a scheduled, non-interactive job (`claude -p` in headless
mode). Execute the steps below in order, using your Metaview and Slack MCP
tools plus the Bash tool to run the Node helper scripts in this repo. Do not
ask the user anything — make the documented default choice and proceed.
Run everything with the repo root (this file's parent's parent directory) as
your working directory.

## 0. Load config

Read `config.json`. You'll use `metaviewFields`, `departmentFieldId`,
`interviewConversationTypes`, `resourceUrl`, `testDmUserId`, and
`reasonFollowups` below. If `sitrepChannelId` is empty, that's fine — it's
not used by this script (only the weekly one).

## 1. Determine run mode

Run `echo "DRY_RUN=$DRY_RUN TEST_SELF=$TEST_SELF RUN_MODE=$RUN_MODE"` via Bash.

- `DRY_RUN=true` → **do not** call `slack_send_message` and **do not** write
  to `state/sit-rep-log.json`. Print exactly what would be sent, to whom, and
  why. This is the mode used for the multi-day review in the testing
  checklist.
- `TEST_SELF=true` → send every message to `testDmUserId` from config
  instead of the real interviewer's Slack ID, and prefix the message with
  `[TEST — would have gone to {{interviewer_name}}]\n\n`. Used for the
  one-time "check tone and formatting" test in the testing checklist.
  **Never write these to `state/sit-rep-log.json`**, even when `DRY_RUN` is
  false — a log entry under the real interviewer's name pointing at your own
  DM thread would corrupt their real miss count, and the weekly job would
  later misread whatever you reply with in your own thread as *their*
  answer. Skip step 8 entirely in this mode.
- `RUN_MODE` — unset/anything else (default, used for the normal 9am
  scheduled run) checks the previous business day. `RUN_MODE=today` is a
  manual-only override for ad hoc same-day dry runs (e.g. spot-checking
  what's accumulated so far this afternoon) — never used by the schedule.

## 2. Compute the date window

Don't hand-compute this with bash date arithmetic — the Friday-to-Monday
rollover is easy to get subtly wrong that way. Instead run (from the repo
root):

```
node bin/window.js previous-business-day --timezone=<timezone from config.json>
```

or, only when `RUN_MODE=today`:

```
node bin/window.js today-so-far --timezone=<timezone from config.json>
```

Parse the printed `{ startISO, endISO, dateLabel }` — these are the window
bounds for step 4, and `dateLabel` (e.g. "2026-08-14") is the day you're
reporting on for step 9's summary.

## 3. Check for replies to prior nudges and send tailored follow-ups

This step is about *previously*-sent nudges, not today's — it resolves any
reply that's come in since the last run and, when the reply maps to a known
reason, sends a short tailored follow-up as a thread reply. It runs every
day (not just weekly) so a follow-up lands promptly instead of up to a week
later, and it reads `state/sit-rep-log.json` directly rather than anything
computed in step 2.

From the full log, find entries where `messageTs` is set, `reason` is null,
and `followupSentAt` is not set — these are `unresolvedEntries` (real nudges
that went out whose reply hasn't been resolved yet; entries never make it
into the log at all under `DRY_RUN`/`TEST_SELF`, so this naturally excludes
those runs' output).

For each entry in `unresolvedEntries`, look for a reply from the interviewer
that isn't from the bot itself, checking **both** of these (a single reply
can land as a plain DM message or as a thread reply, and either one needs to
count):

- `slack_read_thread` with `channel_id: entry.channelId`,
  `message_ts: entry.messageTs` — catches a threaded reply.
- `slack_read_channel` with `channel_id: entry.channelId`,
  `oldest: entry.messageTs` — catches a plain reply typed straight into the
  DM, which `slack_read_thread` alone would miss.

Take the earliest non-bot message found across either call as
`rawReplyText` for that entry (`null` if neither call turns one up). Attach
`rawReplyText` onto each entry — don't parse it yourself, the runner below
does that against the a/b/c/d template.

Write a JSON file (e.g. `/tmp/followup-input.json`):

```json
{
  "entries": [ ...unresolvedEntries, each with rawReplyText attached... ],
  "reasonFollowups": { ...reasonFollowups from config.json... },
  "now": "<current ISO timestamp>"
}
```

Then run:

```
node bin/followup-runner.js < /tmp/followup-input.json > /tmp/followup-output.json
```

Read `/tmp/followup-output.json`. It contains `updatedEntries` (each entry
with `reason`/`replyRaw` resolved wherever a reply came in, and
`followupSentAt` set on any entry that got a follow-up queued — an entry
whose reason has no configured follow-up text, e.g. "d) something else",
still gets `reason` resolved but nothing queued, since that needs a human's
judgment) and `followups` (the messages to actually send: `channelId`,
`messageTs` to reply into, and `text`).

- If `DRY_RUN=true`: print each queued follow-up (who it's for, the thread
  it would reply into, and `text`). Do not call Slack and do not persist
  `updatedEntries` — move on to step 4.
- Otherwise: for each entry in `followups`, call `slack_send_message` with
  `channel_id` = `channelId`, `message` = `text`, and `thread_ts` =
  `messageTs` (a threaded reply on the original nudge, not a new top-level
  message). Then write `/tmp/followup-log-entries.json` as
  `{ "entries": <updatedEntries> }` and run
  `node bin/append-log.js state/sit-rep-log.json < /tmp/followup-log-entries.json`
  to persist the resolved reasons back into the log — do this for every
  entry in `updatedEntries`, not just the ones with a follow-up queued, so a
  resolved-but-unqueued reason (like "d") also stops showing up in
  tomorrow's `unresolvedEntries`.

## 4. Query Metaview for the unrecorded bucket

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
  "default:candidate_application",
  "<departmentFieldId from config>"
]
limit: 200
```

If `total_count` suggests more than 200 rows for the window (unlikely for a
single day, but check), paginate with `offset` until you have them all.

This bucket mixes real missed candidate interviews with recurring internal
syncs that were never supposed to have a bot in them, plus internal
conversations (debriefs, vendor/leadership syncs) that can carry a
candidate participant despite not being an interview, plus ad hoc bookings
("30 min with James (...)", "Tamra <> Kiela : CS @ Luma Chat") that involve
a real candidate but were never scheduled through the ATS-linked interview
loop. Three independent signals combine to catch all of that: the
`conversation_type` filter above scopes the query to real interview types
(Job Interview / Coding Interview / System Design Interview - see
`interviewConversationTypes` in config.json), and the Node runner below
additionally requires both a non-empty `default:candidate` list AND a
non-empty `default:candidate_application` (the linked ATS application
record) in code, since neither field can be filtered server-side. Don't try
to replicate any of these filters yourself by reasoning over the JSON — let
the query and the runner do it deterministically.

Save the raw `conversations` array from the response.

**Important**: `default:conversation_type` and `default:candidate_application`
must stay in the `fields` list above whenever `allowedConversationTypeIds`
is passed to the runner in step 6 — if the runner can't see a
conversation's type, it fails safe and drops that conversation rather than
guessing, so a missing field here silently zeroes out the whole run instead
of loudly erring.

## 5. Resolve Slack IDs for interviewers

Collect every unique interviewer email from the raw conversations (from each
`default:interviewer` entry). For any interviewer object that doesn't already
carry a `slack_id`, call `slack_search_users` with their email to resolve
their Slack user ID. Build a map `{ "email@company.com": "U123..." }` from
the resolved results. Skip (don't error on) anyone you can't find — they'll
show up in the runner's `unresolved` list and you'll report them at the end
instead of silently dropping them.

## 6. Run the daily runner

Write a JSON file (e.g. `/tmp/daily-input.json`) with this shape:

```json
{
  "conversations": [ ...raw conversations from step 4... ],
  "fields": {
    "interviewer": "default:interviewer",
    "candidate": "default:candidate",
    "eventTitle": "default:calendar_event_title",
    "startTime": "default:start_time",
    "department": "<departmentFieldId from config>",
    "conversationType": "default:conversation_type",
    "candidateApplication": "default:candidate_application"
  },
  "allowedConversationTypeIds": [ ...ids from config.json's interviewConversationTypes... ],
  "slackIdMap": { ...from step 5... },
  "now": "<current ISO timestamp>",
  "timezone": "<timezone from config.json>",
  "resourceUrl": "<resourceUrl from config.json>"
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

## 7. Send (or print) the messages

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
  into one DM), set `messageTs` to the ts you just got back and `sentAt` to
  the current ISO timestamp. Leave `channelId` as the entry's real
  `interviewerSlackId` regardless of where you actually sent it in
  `TEST_SELF` mode — see step 8.

## 8. Persist the log (skip entirely if `DRY_RUN=true` OR `TEST_SELF=true`)

A `TEST_SELF` send goes to your own DM, not the interviewer's — logging it
under their name would point the weekly reply-check at the wrong thread and
attribute whatever you reply with to them. So in either `DRY_RUN=true` or
`TEST_SELF=true` mode, stop here: do not call `bin/append-log.js`.

Only when both are false (a real scheduled or manual live run), collect
every entry (across all sent messages) into one array and write it to e.g.
`/tmp/daily-log-entries.json` as `{ "entries": [...] }`, then run:

```
node bin/append-log.js state/sit-rep-log.json < /tmp/daily-log-entries.json
```

## 9. Report a summary

Print a short summary: which day this run covered (`dateLabel` from step 2),
how many raw conversations came back, how many survived the
real-candidate-interview filter, how many DMs were sent (or would be sent,
in dry-run), how many prior-nudge replies were resolved and how many
tailored follow-ups were sent (or would be sent, in dry-run) from step 3,
and list anyone in `unresolved` by name/email so a human can add their
Slack mapping. Do not print full message text again if you already printed
it in step 7.
