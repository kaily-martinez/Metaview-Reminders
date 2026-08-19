# Metaview Reminder Bot

Three jobs:

1. **Daily nudge** — weekdays at 9am, checks the previous business day's
   interviews (a Monday run checks Friday, since the job doesn't run over
   the weekend) for candidate interviews where Metaview wasn't admitted, and
   DMs the internal host(s) a soft, non-accusatory Slack message asking what
   happened. The same run also checks for replies to *prior* nudges and,
   when the reply maps to a known reason, sends a short tailored follow-up
   (see "Reason-triggered follow-ups" below).
2. **Friday outreach list** — Fridays at 10am, posts a plain-text list of
   who's been nudged so far this week to `#metaview-alerts`. A lightweight,
   mid-week companion to the Monday report — no reply-checking or trends,
   just visibility.
3. **Weekly sit-rep** — Monday mornings, aggregates the past week's misses
   and reply data into a message posted to `#metaview-alerts`, so the team
   can track whether this is improving over time. A fresh message each
   week, not an editable document — manual commentary goes as a thread
   reply on that week's post.

**What counts as a "real miss":** a conversation must satisfy all five,
each catching noise the others miss:
1. Non-empty candidate list — filtered in code, since that field can't be
   queried server-side for "is not empty."
2. A `conversation_type` of Job Interview, Coding Interview, or System
   Design Interview (see `interviewConversationTypes` in `config.json`),
   filtered server-side. Excludes an internal "Candidate Debrief" and two
   conversations tagged "Other" (a vendor/ATS sync and an internal
   leadership sync) that all carried a non-empty candidate field despite
   not being real interviews.
3. A non-empty `default:candidate_application` — the conversation must link
   back to an actual ATS (Ashby) application record, filtered in code (also
   not queryable server-side for "is not empty"). Excludes ad hoc bookings
   like "30 min with James (...)" and "Tamra <> Kiela : CS @ Luma Chat" —
   real candidates, real recruiters, but never scheduled through the
   loop-scheduling flow, so they could be one-offs rather than tracked
   interview stages.
4. Not already recorded — its `id` must not appear in a fresh
   `only_show_recorded_conversations: true` query for the same window,
   filtered in code via `filterRealMisses`'s `excludeConversationIds`. This
   one is load-bearing, not just noise-reduction: live testing found that
   Metaview's `only_show_recorded_conversations: false` does **not** mean
   "only unrecorded" — it returns recorded and unrecorded conversations
   alike (confirmed: a conversation with a real recording came back
   identically under both `true` and `false`). Without this exclusion, a
   completely normal, correctly-recorded interview would get nudged as if
   it were missed. See `prompts/metaview-daily-nudge.md` step 4 for the
   two-query fetch this requires.
5. Its event title doesn't match one of `config.json`'s (optional)
   `excludedEventTitlePatterns` — a case-insensitive substring check,
   filtered in code. Real data showed one interviewer's whole miss count
   was almost entirely "Meet & Greet" / "Meet and Greet" events, which
   carry the same conversation_type and a real linked application as
   genuine interviews — title is the only signal that distinguishes them.
   This is a policy call, not a fixed fact, so it's configured per-workspace
   rather than hardcoded; add more patterns here as other non-interview
   title conventions turn up (e.g. "ADMIN"/"TEST" test entries).

**Presumed-departed interviewers are excluded automatically**: an
interviewer who can't be resolved to a Slack user (by email, then by full
name) is treated as no longer employed rather than as a mapping gap to
fix — there's no DM to send someone who isn't in the workspace at all.
This already falls out of the existing architecture rather than needing
new filter logic: an unresolved interviewer never lands in `messages`
(daily-runner.js), so they're never nudged, and since the weekly sit-rep's
"missed" count only comes from what actually got logged, they never count
against a team's miss rate either. They still get named in the daily run's
summary for visibility, but framed as "presumed departed," not as an
action item.

**Named people can be excluded from nudging without being excluded from
the report**: `config.json`'s `doNotMessage` (a list of `{ name, email }`)
is for people who should never get a DM - typically because they're too
senior for an automated bot nudge - but whose misses should still count
toward the by-team/repeat-offender/miss-rate numbers, unlike everything
above (which drops the miss entirely). `lib/filters.js`'s `isDoNotMessage`
matches by email first, falling back to name. `bin/daily-runner.js` routes
a match into a `skipped` bucket instead of `messages` - still logged
(with no `messageTs`/`channelId`, since no DM went out), just never sent.

**Help resource**: both nudge templates append a short, optional pointer to
the team's "Metaview: Admit & Submit" Notion page (`config.json`'s
`resourceUrl`) — on the theory that a lot of misses are people not knowing
the admit prompt exists rather than actively ignoring it. It renders right
before the closing line, e.g. "New to Metaview or forgot how the admit
prompt works? [Admit & Submit guide](...)". Omitted entirely if `resourceUrl`
isn't set. Both templates also name the candidate (e.g. "Recruiter Screen
with Alex Chen") and, in the multi-miss template, tag each time with a
timezone abbreviation (e.g. "1:30 PM PDT") so nothing's ambiguous.

**Reason-triggered follow-ups**: the a/b/c/d question in the nudge isn't
just for tallying - each reply drives a specific next step, grounded in
real material from the team: Maria Mediato's admit reminder and Richard
Cho's company-wide "why Metaview matters" Slack post, and the "Metaview:
Admit & Submit" Notion page (`config.json`'s `resourceUrl`) for the
concrete troubleshooting steps:

- **a) Forgot to admit** → a short reminder that reinforces *why* it
  matters (accurate scorecards, and the offer-acceptance work that depends
  on interview data) and restates the ask: admit it every single time,
  no exceptions.
- **b) Tried, didn't work** → the concrete fix from the Admit & Submit
  page - add `notes@bot.metaview.ai` as a guest on the meeting and it'll
  join within a few minutes (do this before 30 minutes pass, or Metaview
  will have already left) - plus a nudge to flag it to `#hiring` with the
  candidate name and time if it keeps happening, echoing Richard's "don't
  just let it slide."
- **c) Looked like it joined fine** → an acknowledgment plus a prompt to
  flag it to `#hiring` if notes never show up despite that, so a real
  false-positive doesn't get silently repeated.
- **d) Something else** → asks for more context and offers help
  troubleshooting, since there's no way to know what happened without it -
  a human still needs to actually read whatever they send back.

This is configured in `config.json`'s `reasonFollowups` (one string per
reason code; omit a code for no automated follow-up) and resolved daily
(not weekly) by `lib/followup.js` / `bin/followup-runner.js`, so a
follow-up lands promptly - the same day someone replies - rather than
waiting for the Monday sit-rep. A follow-up is sent the same way the person
replied: a threaded reply back for a threaded reply in, a plain message for
a plain reply in (`replyIsThreaded` on each queued follow-up, defaulting to
threaded if unset). Each entry only ever gets one (`followupSentAt` guards
against re-sending if the runner runs again with stale input).

## How this is built, and why

The logic is split into two layers:

- **`lib/` — deterministic, unit-tested JS.** All the parts that must be
  exactly right and repeatable: the "is this actually a candidate interview"
  filter, grouping misses by interviewer, message templating, reply parsing,
  miss-rate/trend math, report markdown rendering, and business-day/week
  window math. None of this touches the network. Run `npm test` any time to
  check it.
- **`prompts/*.md` — instructions for a `claude -p` headless run.** Metaview
  and Slack are only reachable here as MCP tools inside a Claude Code
  session — there's no separate API key this repo can call directly. So the
  actual "script" that cron runs is `claude -p` reading one of these prompt
  files: it makes the live Metaview/Slack MCP calls, shells out to the
  `bin/*.js` runners below for all the number-crunching, and reports back.
- **`bin/*.js` — the glue.** Each takes the raw data Claude fetched via MCP
  (as JSON on stdin), runs it through `lib/`, and returns rendered messages /
  report text / updated state (as JSON on stdout). This keeps every actual
  decision (which conversations count as real misses, what percentage rounds
  to what, which business day a run covers) in testable code instead of
  asked-fresh-each-time LLM judgment — including date math, where a
  Friday-to-Monday rollover done ad hoc in a prompt is an easy place to
  introduce an off-by-one.

This is a deliberate deviation from the original spec's literal
`metaview-daily-nudge.js` / `metaview-weekly-sitrep.js` naming — those exist
here as `prompts/metaview-daily-nudge.md` and
`prompts/metaview-weekly-sitrep.md`, paired with the `bin/` runners they
call out to. It's also a deviation from the spec's original Canvas-based
weekly report: the weekly sit-rep now posts as a plain channel message
(see "Canvas → channel message" below for why).

## Layout

```
config.json                          channel IDs, cached Metaview field IDs, help resource URL
state/sit-rep-log.json               every nudge ever sent + reply data (source of truth)
state/weekly-history.json            last 5 weeks' scheduled/missed/miss-rate (for the trend section)
lib/filters.js                       real-miss filter, interviewer grouping, name/department normalization
lib/templates.js                     DM message templates, date/time/timezone formatting
lib/aggregate.js                     reply parsing, miss-rate math, by-team rows, repeat-offender detection
lib/followup.js                      resolves fresh replies into reason codes + queues tailored follow-up text
lib/report-render.js                 renders the weekly sit-rep as a markdown message
lib/log-store.js                     read/write/upsert state/sit-rep-log.json
lib/schedule.js                      timezone-correct business-day/week window math
lib/outreach.js                      groups + renders the Friday outreach-list report
bin/window.js                        prints query window bounds (previous business day / today-so-far / week-so-far)
bin/daily-runner.js                  conversations + resolved Slack IDs -> rendered DMs + log-entry skeletons
bin/followup-runner.js               unresolved log entries + fresh replies -> resolved reasons + queued follow-ups
bin/append-log.js                    appends/upserts entries into state/sit-rep-log.json
bin/outreach-runner.js               this week's log entries -> the Friday outreach-list message
bin/weekly-runner.js                 week's log + fresh Metaview counts + history -> report message + updated state
prompts/metaview-daily-nudge.md      claude -p prompt for the daily job (nudges + reply/follow-up check)
prompts/metaview-friday-outreach.md  claude -p prompt for the Friday outreach-list job
prompts/metaview-weekly-sitrep.md    claude -p prompt for the weekly job
test/run-tests.js                    assertion tests for everything in lib/
```

## Canvas → channel message

The original spec called for the weekly sit-rep as a Slack Canvas (an
editable persistent document, updated in place each week, with a manually-
edited "Notes" section preserved across updates). It's built here as a
plain message instead, posted fresh every Monday: simpler to reason about
(no create-vs-update branching, no matching-sections-by-heading-text logic,
nothing that can drift out of sync with a manually-edited document), and it
threads naturally — team commentary goes as a reply on that week's message
instead of an edited section.

## One-time setup

1. Make sure the Metaview and Slack MCP servers are connected to whatever
   Claude Code session/environment will run these prompts.
2. Create the Slack channel for the weekly report and Friday outreach list,
   then put its channel ID in `config.json`'s `sitrepChannelId`.
3. `config.json`'s `departmentFieldId` is already filled in with this
   workspace's live OSPT Department field ID
   (`OSPT:451a0128-1a7a-11f0-910a-bfcaaf3ed43b`), discovered via
   `list_fields`. If your Metaview workspace ever changes, re-run
   `list_fields` with `search_term: "department"` and update it.
4. `config.json`'s `interviewConversationTypes` is filled in with this
   workspace's real `conversation_type` values, discovered via
   `list_fields`/`group_conversations`: Job Interview, Coding Interview, and
   System Design Interview are treated as real interviews; Candidate
   Debrief, Client Call, Role Intake, and Other are not. If new conversation
   types get introduced later, re-run `group_conversations` grouped by
   `default:conversation_type` to check the set is still complete.
5. `config.json`'s `excludedEventTitlePatterns` holds case-insensitive event
   title substrings that never count as a miss (currently `"meet & greet"`
   and `"meet and greet"`, discovered from real data). Add more as other
   non-interview title conventions turn up, or clear it if you'd rather see
   everything.
6. `config.json`'s `doNotMessage` lists people (`{ name, email }`) who
   should never get a nudge DM but whose misses should still count toward
   the report. Empty by default; add names as they come up.
7. `config.json`'s `resourceUrl` points at the team's "Metaview: Admit &
   Submit" Notion page. Update or clear it if that doc moves or you'd
   rather not include the link.
8. `config.json`'s `testDmUserId` defaults to the currently-authenticated
   Slack user (used for the "send yourself a test DM" step below). Change it
   if that's not you.
9. `config.json`'s `reasonFollowups` holds the tailored follow-up text sent
   per reply reason (see "Reason-triggered follow-ups" above). Update the
   wording to match your team's voice, or drop a code's key entirely if you
   don't want an automated follow-up for that reason.
10. `npm test` — confirm all `lib/` tests pass before trusting live output.

## Running manually

From the repo root, in a Claude Code session with the Metaview + Slack MCP
servers connected:

```
DRY_RUN=true claude -p "$(cat prompts/metaview-daily-nudge.md)"
```

```
DRY_RUN=false TEST_SELF=true claude -p "$(cat prompts/metaview-daily-nudge.md)"
```

```
claude -p "$(cat prompts/metaview-friday-outreach.md)"
```

```
claude -p "$(cat prompts/metaview-weekly-sitrep.md)"
```

`DRY_RUN` and `TEST_SELF` are read by the daily prompt (see step 1 in that
file) — unset/false means the normal live-send path. `RUN_MODE=today` is
also available on the daily prompt as a manual-only override for same-day
ad hoc checks; the scheduled run never sets it.

## Testing checklist (do this before scheduling)

- [ ] Run the daily prompt with `DRY_RUN=true` for 2-3 days running; manually
      cross-check the flagged interviews against the Metaview web app to
      confirm they're real misses, not noise (recurring syncs, etc.).
- [ ] Run once with `DRY_RUN=false TEST_SELF=true` to send one real DM to
      yourself and check tone/formatting render correctly in Slack.
- [ ] Reply to that test DM with each of `a`, `b`, and `c` in turn (in
      separate test sends, since a real entry only follows up once) and
      confirm the right `reasonFollowups` text comes back as a threaded
      reply on a subsequent `DRY_RUN=false` run — note that `TEST_SELF`
      sends are never logged (see step 8 of the daily prompt), so use a
      real (non-`TEST_SELF`) send to your own account, or a throwaway entry
      appended directly to `state/sit-rep-log.json`, to test this end-to-end.
- [ ] Backfill a week of dry-run data into `state/sit-rep-log.json` (or let
      a few real days accumulate), then run the Friday outreach prompt and
      the weekly prompt once manually and review both before scheduling.
- [ ] Once all three look right, come back and we'll set up the crontab
      entries together (see below — don't install these yet).

## Cron (draft — set these up together once testing above is done)

```cron
# Daily nudge — weekdays at 9am, covers the previous business day
0 9 * * 1-5 cd /path/to/this/repo && DRY_RUN=false claude -p "$(cat prompts/metaview-daily-nudge.md)" >> logs/daily-nudge.log 2>&1

# Friday outreach list — Fridays at 10am
0 10 * * 5 cd /path/to/this/repo && claude -p "$(cat prompts/metaview-friday-outreach.md)" >> logs/friday-outreach.log 2>&1

# Weekly sit-rep — Monday mornings at 8am
0 8 * * 1 cd /path/to/this/repo && claude -p "$(cat prompts/metaview-weekly-sitrep.md)" >> logs/weekly-sitrep.log 2>&1
```

Replace `/path/to/this/repo` with the real path once you know where this
will run, and make sure that machine's Claude Code has the Metaview/Slack
MCP servers configured (cron runs headless — there's no interactive
approval, so tool calls need to be pre-approved for that environment).

## Backlog / parked ideas

- **CHRO-level summary (Richard Cho)**: the current weekly post is built for
  Josh Gill (Head of RecOps/Talent Engineering/People Systems) — the actual
  operational owner, who wants the full detail (by-team, reason codes,
  repeat pattern) to act on. A CHRO wants something much lighter and
  separate: one line + trend direction, no names, no tables, low cadence
  (e.g. monthly) — not a seat in the operational channel. Parked until
  Kaily decides whether that should be its own scheduled post/DM or folded
  into something Richard already reads. Not built yet.
