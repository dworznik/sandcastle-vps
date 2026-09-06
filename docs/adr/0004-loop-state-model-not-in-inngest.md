# The Loop's state model lives outside Inngest

The Loop has to answer one question continuously: what Phase is each issue in, and what is it waiting for? The obvious home is Inngest, which already queues and executes Runs — but Inngest cannot answer it. A run parked in `waitForEvent` reports as `RUNNING`; the server's own enum records that this is "the default state, even if steps are scheduled in the future", and `StepStatusWaiting`, `StepStatusSleeping`, and `StepStatusInvoking` all collapse into it. The REST v2 run-status vocabulary is `QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED`, with no waiting value to filter on — `WAITING` exists only per trace span, so "which issues are awaiting review?" would mean walking every run's trace tree. Nor is there entity state to fall back on: state is per-run step memoization, discarded when the run ends, and `meta.sessions` — the one primitive that would correlate Runs to an issue — returns 501 in the self-hosted build.

State is therefore split three ways. **Inngest owns execution state**: the in-flight Run, exclusive claim via `singleton` keyed on the issue, cancellation, and flow control. This extends ADR 0002's line — Inngest is for queueing, concurrency, and visibility, not durability, and not state either. **GitHub is ground truth for outcomes**: whether a Task Branch exists, whether a pull request exists, its CI conclusion, its review comments, whether it merged. Those are facts about the world rather than state this system elects to keep, so the Loop derives them on each poll and never mirrors them. **A local store holds the queryable projection**: issue, Phase, attempt counts, backoff deadlines, the Limit Gate, and the halt flag — only what cannot be derived from GitHub.

The deciding trade-off is between cheap state and self-healing state. Deriving from GitHub costs API calls on every poll and cannot be made transactional, whereas mirroring would be cheaper and atomic. But most of the Loop's Phases are waiting states whose evidence is a GitHub artifact, so a store that derives can be rebuilt by asking GitHub, while a store that mirrors diverges silently and stays wrong. The projection is the newest and least trustworthy component in the system; making it disposable is worth more than making it fast.

## Considered Options

- **Tracker-as-state** — encode Phase in labels and attempt counts in comments. Rejected: labels have no compare-and-swap, so claiming is racy; counters in comments pollute the surface the human actually reads; and every transition spends the same API budget the polling watcher depends on. The five triage labels stay human-meaningful and carry no machine state.
- **Inngest-as-state** — one long-lived run per issue, looping on `waitForEvent`. Rejected for the status opacity above, and bounded besides: 1000 steps and 366 days per run, with no way to query by Phase.
- **Inngest Cloud** — evaluated separately and rejected; it does not change this decision. See ADR 0005.

## Consequences

- The projection is a cache, never a source of truth for anything GitHub knows. Deleting it must be safe, and recovery is a full poll — treat any design that makes the store authoritative for an outcome as a bug.
- Reconciliation is one-way: where the store and GitHub disagree about an outcome, GitHub wins.
- Dispatch events must carry the issue identity so the projection can point at the Run it spawned. `meta.sessions` may be written for parity with Cloud, but must never be relied on for queries.
- `sandcastleRun` currently makes no `step.*` calls, so it holds no Inngest state today. Adopting `singleton` for the claim is the one Inngest primitive this decision actually requires.
- Do not re-file this as "just track it in Inngest". The blocker is the run-status data model, not configuration, and it is identical self-hosted and on Cloud.
