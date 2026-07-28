# Research: headless Claude Code at subscription rate limits

Resolves [#11](https://github.com/dworznik/sandcastle-vps/issues/11). Feeds the
"guardrails and kill switch" decision ([#16](https://github.com/dworznik/sandcastle-vps/issues/16)).

**Question.** What happens when a headless Claude Code run (authenticated via
`CLAUDE_CODE_OAUTH_TOKEN` on a Max subscription) hits the 5-hour or weekly usage
limit mid-run? Error shape, exit behavior, retry-after signal, fate of partial
work, how sandcastle surfaces it — and what an unattended orchestrator should do.

Facts are separated from inference throughout. "Verified" means read directly
from the primary source during this research (2026-07-28); "community-reported"
means sourced from Claude Code GitHub issues that were not all individually
re-verified.

---

## 1. Facts — what `claude -p` does when the subscription limit is hit

### Underlying error shape (verified, official + GitHub issue)

The subscription limit surfaces as a standard API rate-limit error, HTTP 429:

```json
{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}
```

Verified in [anthropics/claude-code#2087](https://github.com/anthropics/claude-code/issues/2087)
(error log excerpt) and matching the documented API error shape
([API errors](https://platform.claude.com/docs/en/api/errors),
[API rate limits](https://platform.claude.com/docs/en/api/rate-limits)). At the
raw API level the response carries `retry-after` (seconds) and
`anthropic-ratelimit-*-reset` (RFC 3339) headers — but **Claude Code does not
expose these headers to the caller**.

### Streamed JSON behavior mid-run (verified, official)

With `--output-format stream-json` (what sandcastle uses), a retryable API
failure emits a documented `system/api_retry` event before Claude Code retries
internally ([headless docs](https://code.claude.com/docs/en/headless#stream-responses)):

| Field | Meaning |
|---|---|
| `subtype` | `"api_retry"` |
| `attempt`, `max_retries` | retry progress |
| `retry_delay_ms` | milliseconds until next attempt |
| `error_status` | HTTP status (429 for rate limit) |
| `error` | category string, including `rate_limit` and `billing_error` |

This is the only *machine-readable* rate-limit signal in the stream. It fires
for transient 429s that Claude Code will retry itself. When the subscription
window is actually exhausted (no extra usage enabled), retries do not help and
the run hard-stops.

### Exit behavior at hard stop (community-reported)

- Claude Code **hard-stops with no recovery path** when the 5-hour window is
  exhausted; the accepted workaround is an external wrapper loop keyed on a
  non-zero exit code ([#36320](https://github.com/anthropics/claude-code/issues/36320), verified — includes the wrapper script).
- Exit code is the **generic error exit 1**. There is no dedicated rate-limit
  exit code (exit 75 was proposed in #36320; a `--wait-on-limit` flag was also
  requested; neither shipped). Documented exceptional exit: 143 on SIGTERM.
- The user-facing message has taken several forms across versions:
  `Claude AI usage limit reached|<epoch>` (raw epoch,
  [#2087](https://github.com/anthropics/claude-code/issues/2087)),
  `Claude usage limit reached. Your limit will reset at 1pm (Etc/GMT+5)`
  (verified in #2087), `5-hour limit reached ∙ resets <time>` (later versions).
  Timezone rendering has known bugs
  ([#5085](https://github.com/anthropics/claude-code/issues/5085)).
  **The message format is undocumented and unstable — do not build a strict
  parser against it.**

### Limit hit at start vs mid-run (fact + inference)

The limit is enforced per API request, so "at start" and "mid-run" look the
same: the first request that would exceed the window gets the 429. Mid-run the
agent has typically already made tool calls and possibly commits; at start it
has done nothing. Either way the process ends with the limit message and a
non-zero exit (inference from the per-request enforcement model; consistent
with all issue reports).

### Auth token (verified, official)

`claude setup-token` mints a **one-year** OAuth token that authenticates with
the subscription and can only make model requests
([authentication docs](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)).
Community issues about tokens expiring after ~8–10 hours in CI
([#28827](https://github.com/anthropics/claude-code/issues/28827),
[#38813](https://github.com/anthropics/claude-code/issues/38813)) concern
**`/login` session credentials reused headlessly, not `setup-token` tokens** —
they do not apply to this harness. Note: `--bare` mode does not read
`CLAUDE_CODE_OAUTH_TOKEN` (documented); sandcastle does not pass `--bare`, so
this is not currently a concern.

### Usage windows (official support docs, low detail)

Pro/Max subscription usage is limited per rolling 5-hour window plus an overall
weekly limit; Claude Code shares this quota with claude.ai usage
([support.claude.com: models, usage and limits in Claude Code](https://support.claude.com/en/articles/14552983)).
The support article describes the stop as "a 'limit reached, resets at *time*'
message". Exact quota sizes are not published and vary with model and load.

---

## 2. Facts — how sandcastle surfaces it (verified in `@ai-hero/sandcastle` 0.12.0 dist)

Sandcastle invokes, inside the container:

```
claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model <model> -p -
```

with the prompt on stdin (`node_modules/@ai-hero/sandcastle/dist/index.js`,
`claudeCode().buildPrintCommand`).

### Failure path: non-zero exit → thrown `AgentError`

If the claude process exits non-zero, the iteration fails with:

```
AgentError: claude-code exited with code <N>:
<stderr, or the parsed result text, or the last 20 non-empty stdout lines>
```

(`invokeAgent` in `dist/index.js`.) Because the stream parser captures
`{"type":"result","result":"…"}` text as `resultText`, **the usage-limit
message — including any reset time it contains — typically lands inside
`AgentError.message`**. The `run()` promise **rejects**; on this path the
caller receives *no* `RunResult` — no `completionSignal`, no `commits`, no
`iterations`, and **no captured `sessionId`** (session capture runs after a
successful agent invocation, so a limit-killed iteration cannot be resumed via
`resumeSession`).

`AgentError` is enriched with `preservedWorktreePath` when the worktree had
uncommitted changes (`attachPreservedPath` in `dist/chunk-VOG34SRF.js`).

### Success-shaped path: zero exit with a limit message

If a claude build exits 0 after printing the limit message (observed in some
versions), sandcastle treats it as a **normal iteration with no completion
signal**: the loop proceeds to the next iteration (which hits the limit again
immediately) until `maxIterations`, then `run()` **resolves** with
`completionSignal: undefined` and the limit text present in `result.stdout`.

### Partial work survives on the Task Branch

With `branchStrategy: { type: "branch" }` (the only strategy this harness
allows, ADR 0001), the agent commits directly to the named branch through the
bind-mounted worktree. **Commits made before the failure are ordinary git
commits on the Task Branch and survive the thrown error** — the error path
merely skips sandcastle's commit *collection*, so they are not reported in a
result object. Worktree cleanup on failure: preserved on disk if dirty
(path attached to the error), removed if clean. Nothing is rolled back.

### This harness's current behavior (verified, `src/functions/run.ts`, ADR 0002)

The Inngest function runs with `retries: 0` (deliberate — a retry would restart
the whole agent run and silently burn subscription quota). So today a
rate-limited Run simply **fails once in Inngest** with the `AgentError` as the
failure reason, and the Task Branch keeps whatever was committed.

---

## 3. Facts — querying limits ahead of time

There is **no supported way to query remaining subscription quota
programmatically** (as of 2026-07):

- `/usage` works only interactively; in headless mode it fails, and its backing
  endpoint 429s under polling
  ([#32503](https://github.com/anthropics/claude-code/issues/32503)).
- No `claude usage --json` / statusline quota export — repeatedly requested,
  closed as duplicates
  ([#40793](https://github.com/anthropics/claude-code/issues/40793),
  [#27915](https://github.com/anthropics/claude-code/issues/27915),
  [#50518](https://github.com/anthropics/claude-code/issues/50518)).
- The undocumented `/api/oauth/usage` endpoint is itself aggressively
  rate-limited ([#31637](https://github.com/anthropics/claude-code/issues/31637)) — unfit for unattended polling.
- No quota information is written to `~/.claude.json` or other local files.
- `--output-format json` reports per-run token usage and `total_cost_usd`
  (sandcastle exposes tokens as `IterationUsage`) — useful for accounting, but
  it is consumption, not remaining quota.

Community practice for unattended use is therefore **reactive**: run, detect
the limit from the failure, sleep, retry. The canonical wrapper is a
poll loop on non-zero exit (#36320); tools like
[unsnooze](https://github.com/saaranshM/unsnooze) do the same with parsed reset
timestamps persisted to disk.

---

## 4. Inference — failure taxonomy for the orchestrator

From the above, a Run that hits the subscription limit reaches the harness in
one of two shapes, and the discriminating signal is textual:

| Shape | How it arrives | Rate-limit signal |
|---|---|---|
| Thrown `AgentError` | `run()` rejects, Inngest run fails | limit pattern in `error.message` |
| Resolved, no completion | `run()` resolves, `completionSignal === undefined` | limit pattern in `result.stdout` tail |

Suggested detection patterns (case-insensitive, keep loose):
`usage limit reached`, `limit reached`, `will reset at`, `resets`, `rate_limit_error`,
`rate limit`, `429`. Reset-time extraction is best-effort only: try
`\|(\d{10})` (epoch after a pipe) and `reset(?:s)? at ([^\n]+)`; treat parse
failure as "unknown reset".

Everything not matching those patterns is a genuine failure (bug, image
problem, idle timeout — sandcastle throws distinct `AgentIdleTimeoutError` for
the latter) and should not be retried as a rate limit.

---

## 5. Recommended handling policy

For the unattended orchestrator (Inngest function + future autonomous loop):

1. **Key on the message, not the exit code.** Classify a Run as rate-limited
   when it either throws `AgentError` whose message matches the limit patterns,
   or resolves without a `completionSignal` and the stdout tail matches. Exit
   codes are undocumented and non-specific (always 1).
2. **Back off until the window resets; do not blind-retry.** Keep Inngest
   `retries: 0` (ADR 0002 stands — an immediate retry burns the remaining
   window for nothing). Instead, on a rate-limit classification, schedule a
   *re-dispatch* of the same task to the same Task Branch:
   - if a reset time was parsed from the message: at reset time + 5–10 min
     jitter;
   - otherwise: after a fixed 60-minute delay (a 5-hour rolling window
     guarantees progress within at most 5 h; 60 min bounds wasted wall-clock
     without hammering).
3. **Pause globally, not per-run.** The quota is account-wide, so one
   rate-limited Run means every queued Dispatch will also fail. Hold a single
   "limit gate" timestamp in the Orchestrator; while it is in the future, defer
   all Runs, not just the failed one.
4. **Escalate instead of backing off when the horizon is long or detection is
   suspect.** Escalate to a human (and stop the autonomous loop — this is the
   kill-switch input) when any of:
   - a re-dispatched Run is rate-limited again immediately (≤ ~5 min of agent
     activity) **twice in a row** — the parsed reset was wrong or the weekly
     limit is exhausted;
   - total deferral for a task exceeds ~12 h — consistent with the weekly
     limit, whose reset is days away and not worth polling;
   - a run fails with a *non*-matching error — never auto-retry those.
5. **Partial work needs no special handling.** Commits already on the Task
   Branch survive; re-dispatching to the same branch continues the task (the
   domain already defines this). Do not attempt session resume after a
   rate-limit failure — no `sessionId` is captured on the error path. Include
   `preservedWorktreePath` from the error in the failure record for debugging.
6. **Do not pre-flight quota checks.** There is no supported endpoint, the
   unofficial one rate-limits itself, and a canary `claude -p` call spends the
   very quota it is checking. React, don't predict.
7. **Optional hardening:** enable sandcastle's `logging.onAgentStreamEvent`
   raw-line forwarding and watch for `system/api_retry` events with
   `error: "rate_limit"` — the only documented machine-readable signal — to
   flag "approaching the limit" while a Run is still in flight.
