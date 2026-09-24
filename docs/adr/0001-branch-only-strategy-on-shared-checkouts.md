# Branch-only strategy on shared checkouts

> **Rationale amended by ADR 0006 (2026-09-06), corrected by ADR 0007 (2026-09-24).** The claude-tmux session this ADR cites is deprecated as a _product_, but the shape it describes is what a Session becomes: the operator working in the Project checkout itself. So the sentence ADR 0006 added — that sessions operate on worktrees — is wrong, and the reason the conclusion stands is narrower than it claimed. The checkouts on the Target's disk remain the durable home of every Project, and a **Run** is hard-locked to the `branch` strategy because an unattended agent merging into HEAD could destroy uncommitted work in a live checkout. A **Session** is not a Run and carries no such lock: the operator commits where they choose, exactly as they do in a claude-tmux session today. An agent invoked _from_ a Session still lands on a Task Branch, because sandcastle creates the worktree. `head` and `merge-to-head` remain footguns for Runs, which is what this ADR is about.

Sandcastle Runs operate on the same project checkouts the user works in interactively via claude-tmux sessions (mounted from the VPS host's workspace root), because that makes a Run's result appear as a git branch directly inside a live session — no push/pull round-trip to review agent work. The price of sharing is that sandcastle's `head` and `merge-to-head` strategies become data-loss footguns: an agent merging into HEAD while the user has uncommitted changes or an in-progress rebase in that checkout could destroy work. The harness therefore hard-locks every Run to the `branch` strategy — agent commits only ever land on a named task branch via a separate git worktree, and the harness exposes no way to select another strategy.

## Considered Options

- **Dedicated clones for sandcastle** — total isolation, rejected for the review friction (branches must round-trip through GitHub) and a second set of checkouts to keep fresh.
- **Shared checkouts, strategy per-run** — rejected: the flexibility is exactly the footgun.

## Consequences

- Re-dispatching to an existing task branch reuses its worktree (sandcastle behavior) — this is the intended way to iterate on a task, not a conflict to prevent.
- If a genuinely isolated run is ever needed, the answer is a dedicated clone, not unlocking `merge-to-head` on the shared checkout.
