# Metaview Friday Outreach List — runner prompt

Runs Fridays at 10am. A lightweight, mid-week companion to the Monday
Canvas sit-rep: posts a plain list of who's been nudged so far this week to
`#metaview-alerts`, so the team has visibility without waiting until
Monday. It does not check for replies or compute trends — that's the
Monday job's Canvas.

You are running as a scheduled, non-interactive job (`claude -p` in headless
mode). Execute the steps below in order. Do not ask the user anything.
Run everything with the repo root (this file's parent's parent directory) as
your working directory.

## 1. Load config and state

Read `config.json` (`sitrepChannelId`, `timezone`) and the full
`state/sit-rep-log.json` array. If `sitrepChannelId` is empty, stop and
report that the channel hasn't been configured — do not guess one.

## 2. Compute this week's window

```
node bin/window.js week-so-far --timezone=<timezone from config.json>
```

Parse the printed `{ startISO, endISO }` — Monday of this week (local
midnight) through right now.

## 3. Run the outreach runner

Write a JSON file (e.g. `/tmp/outreach-input.json`):

```json
{
  "entries": [ ...the full state/sit-rep-log.json array... ],
  "windowStartISO": "<startISO from step 2>",
  "windowEndISO": "<endISO from step 2>",
  "timezone": "<timezone from config.json>"
}
```

Then run:

```
node bin/outreach-runner.js < /tmp/outreach-input.json > /tmp/outreach-output.json
```

Read `/tmp/outreach-output.json`. It contains `text` (the fully rendered
Slack message — already filtered to this week's misses and grouped by
interviewer) and `stats`.

## 4. Post it

Call `slack_send_message` with `channel_id` = `sitrepChannelId` from config
and `message` = the `text` from step 3. This is a plain channel message, not
a Canvas — no create/update distinction to worry about.

## 5. Report a summary

Print how many misses and how many interviewers this week's report covered,
and the Slack message link.
