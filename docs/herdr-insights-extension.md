# Personal Insights extension

This fork adds connected-machine usage, Cursor account usage, automatic
continuations, and explicit user feedback to the upstream native dashboard.

## Install and enable

```sh
npm run install:local --prefix herdr-insights -- --integrations
```

The installer performs its staged native check and preserves usage data and
shipped Herdr files. It clones the native tabs mod into a personal mod and puts
a yellow chicken immediately before the native right-hand controls. Insights
stays at the right. Edited layouts are preserved and rejected rather than
overwritten. No keyboard binding or Undo button is added.

To disable collection without deleting any history, set `enabled` to `false`
in `~/.config/herdr-app/data/insights/integrations.json`.

## Machines and retained history

Each refresh discovers non-temporary machines using `hc machine ls`. Connected
machines receive a content-addressed collector under their own
`~/.cache/herdr-insights/collectors/`. No machine name is hardcoded. Node 22.15+
must already be available in that machine's login environment.

The collector incrementally reads the existing Pi, Codex, Claude Code, OpenCode,
and Antigravity sources. Its store remains on that machine. Only allowlisted
usage aggregates and continuation metadata cross the existing Herdr connection;
transcripts, prompts, credentials, parser state, and evidence folders are excluded.
Foreground slices use an eight-second scan budget. At most two machines are
updated concurrently, with a total per-machine request deadline. Incomplete
scans continue on subsequent refreshes. Existing upstream behavior may use a
managed worker for giant compressed archives.

Local `fleet.json` retains accepted snapshots and events by stable Herdr machine
identity. Repeated exports replace matching buckets rather than adding them.
Missing buckets, offline/removed machines, and renamed hosts retain history.
The dashboard shows last successful sync and scan completion separately.
The Data scope selector distinguishes All data, All machines, individual
machines, and Cursor account billing. All machines excludes account-level usage.
Selection scopes lifetime metrics, the heatmap, feedback, and usage.
Tool, provider, and model filters further scope the model section.

Remote collectors use the dashboard timezone; remote stores are separated by
timezone because existing daily aggregates cannot be rebucketed accurately.
Session identities are qualified by machine. Transcripts independently copied
between hosts can count in both host totals: aggregate snapshots cannot prove
event-level identity across hosts.

## Cursor

The read-only Cursor SQLite billing cache provides daily model totals. Accepted
account history is retained in `cursor-account.json` as caches rotate. If a usable
local login is available, the official Cursor account CSV export is refreshed
with a ten-second timeout. Login values are neither logged nor persisted by this
extension. Failed authentication/export retains previous data and reports stale
coverage. No sign-in or Keychain change is performed.

Cursor billing data is **account-wide**, so its scope is shown separately as
**Cursor account**, with an account-wide description. It does not invent session counts, machine
attribution, task duration, or an input/output/cache breakdown. The cache toggle
cannot separate cache tokens in this total-only source. Cached coverage and
observation time are visible. Context-window occupancy and request/cost counts
are never converted into token consumption.

## Automatic continuations

Only these producer logs are read:

- `~/.local/state/herdr-autopilot/decisions.jsonl`
- `~/.local/state/herdr-autopilot-hc/decisions.jsonl`
- `~/.local/state/pi-settle-judge/decisions.jsonl`

Shepherd's `would_action: nudge_continue` is counted as acknowledged only when
`injected` is true and `dry_run` is false. A present `inject_error` without success
means the delivery routine was invoked, including possible precheck failure.
Stop hooks require `result: continue`, `counted` or `continued` true, and no dry run;
legacy `action: continue` is accepted. This proves continuation output was issued,
not that the coding agent resumed work. `ask_to_structure` is excluded.

Original records are hashed on the producer host for deduplication, then reduced
to allowlisted fields. Copying or pruning logs does not increment old events or
remove accepted history. Unterminated final records wait for a complete newline.
The hook's `model` is a **judge model**, so it is never attributed to the coding
agent. Session strings are hashed for exported continuation events. Tables show
calendar week/month/year counts and retained totals grouped by tool, combining
acknowledged shepherd sends and issued stop-hook continuations in one row.
Unsuccessful attempts and held/dry-run events remain separate from the counts;
original trigger sources remain in the retained records. Producer history may
already have been pruned before first collection.

## Scream

Focus an agent terminal and squeeze the yellow **chicken**. The toolbar captures that terminal
before focus changes and appends one event to local `events.jsonl`: UUID, timestamp,
stable machine identity, terminal, tool, session ID, model, and attribution evidence.
Every click reacts immediately with a native squeeze effect and a short synthetic
rubber squeak. Clicks are recorded independently in the background; there is no
Saving label, busy gate, or Undo button. No prompt is sent to the agent. A cleanup
operation can append compensating records without erasing the audit log.

PID-specific Claude metadata is checked against process start identity. Explicit
labels and resume arguments are additional evidence; resume arguments describe
the launch session and may become stale after an in-process session switch.
Known Codex session models are looked up in read-only thread metadata. For a
shared-daemon TUI without an explicit session argument, the model displayed in
the current terminal footer is captured with `modelEvidence: terminal-footer`.
Only status-bar-shaped rows at the bottom of the current screen are accepted;
chat mentions and global defaults are excluded, and no screen text is persisted.
This can resolve the model while the session identity remains unknown. Claude
uses the last reported model in the exact session. Unknown session/model fields
remain unknown. Directory recency is never used to guess identity. The foreground
PID is rechecked before saving, to reject process changes during resolution.

The command-line `actions.mjs clear <data-directory>` clears Scream records only,
keeping a private rollback copy. A timestamp marker prevents a click started
before clearing from reappearing when its background lookup finishes. Usage and
continuation history are preserved; append operations share the cleanup lock.

Screams are explicit user feedback, not an objective model-quality score.
Tables show counts by model for the current calendar week, month, and year.
No synthetic feedback events are added to a user's history during tests.

## Chart periods

The model chart and ranking share the selected calendar range. Week and Month
use daily buckets; Year uses monthly buckets and respects the selected year.
All retains the trailing 26-week trend. Period, model, tool, provider, and data
scope changes all participate in the prepared-dashboard cache key.

## Validation

`tests/herdr-insights/fleet-events.test.mjs` uses temporary files and an injected
Herdr runner to test dynamic discovery, stable identities, retained history,
allowlisted exports, machine scope, Cursor accounting, producer-log pruning,
idempotence, feedback undo, and unknown session attribution. Normal presenter
fixtures do not enable integrations, so unit tests cannot contact real machines
or Cursor. Native populated-render checks use synthetic data in a temporary app
home. Real-machine validation must report actual coverage and completion.

Validation snapshot (2026-11-06, macOS / Node 26): 93 targeted tests passed;
ESLint, package checks, and 10,000-row native dashboard/menu/settings checks
passed. The full suite had 253 passes, 3 skips, and 2 Antigravity worker-interrupt
failures; the same failure class reproduces in the unmodified upstream checkout.
No Antigravity collector implementation was changed by this extension.
