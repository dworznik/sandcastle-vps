# Inngest as Run orchestrator, with retries disabled

Dispatching a Run must be cheap and non-blocking — the main callers are agents inside claude-tmux sessions that shouldn't hold a blocking process for a 10–60 minute agent run — which means job state, queueing, and visibility have to live somewhere. Rather than hand-rolling a mini job queue (state files, PIDs, log capture, a status command), the harness is shaped as an Inngest app: a self-hosted Inngest server runs in this stack, the VPS-side command is a thin event sender, and a `sandcastle/run.requested` event triggers the function that executes `sandcastle.run()`. This buys queueing, per-project concurrency limits (max 1 concurrent Run per Project, protecting the shared checkouts), and a run-history dashboard for the cost of one extra container.

Retries are deliberately set to 0, cutting against Inngest's headline feature: a Run is a single long opaque step, so a mid-run failure retried by Inngest would restart the entire agent run from scratch, silently burning Claude subscription usage. Inngest is used here for queueing, concurrency, and visibility — not durability. Do not "fix" the missing retries.

## Considered Options

- **Synchronous CLI + tmux backgrounding** — simplest stack, rejected because agent callers must block and there is no run history.
- **Hand-rolled detached job queue** — rejected as reinventing what Inngest provides, poorly.
