# Delivery inside the Run, with the Base as a Run input

A Run produced a signed commit on a Task Branch in the Target's checkout and stopped there. Nothing pushed it and nothing opened a pull request, so the push happened only when an operator happened to write "push and open a PR" into the task text — which made the most important step of an unattended system depend on prose, and made its absence silent. An agent that forgot to push looked exactly like an agent that had nothing to do. **A Run now Delivers: it pushes its Task Branch and opens or updates a pull request, and its result says which of four things happened.**

**Delivery belongs to the Run.** Not a later Loop phase, and not a second Orchestrator function: the Run's result has to carry the pull request URL, because that URL is what the Loop's one human gate acts on, and only something inside the Run can put it there. The alternative considered and rejected was appending push-and-PR instructions to every task prompt — cheap, and agent-dependent in the one way that matters, since the Harness could not then tell "nothing to commit" from "forgot to push".

**The Base is an input to a Run**, defaulting to the Project remote's default branch, resolved from the GitHub API rather than from the checkout's `origin/HEAD` — a ref written once at clone time, which on a checkout the platform has held for months is stale or absent. The Run fetches, then cuts a new Task Branch from the remote-tracking ref. This is ADR 0001's hazard in a new place: on a shared checkout the operator's HEAD must not silently become the agent's starting point. On a re-dispatch the Base is read back from `branch.<name>.sandcastleBase` in the Project's own config, and a Dispatch naming a conflicting Base is **refused** — rebasing an existing Task Branch onto a different Base is the work-eating surprise ADR 0001 exists to prevent.

**The Base is recorded against the branch before the Run, not after it.** sandcastle creates the Task Branch when it creates the worktree, which is before the agent starts — so a Run that fails still leaves a real branch behind, and a branch with no recorded Base is one a later Dispatch could silently re-point: sandcastle ignores its `baseBranch` for a branch that exists, so the work would continue from the old start point while its pull request proposed it against a new Base. The cost is a recorded Base for a branch that was never cut, in the narrow case of a Run failing before its worktree exists; that makes a later Dispatch naming a different Base refuse and say to use a new branch, which is the conservative direction to be wrong in.

**"Nothing to deliver" is about the branch, not about this Run.** A Task Branch not ahead of its Base has nothing to propose; a re-dispatch that added no commits of its own still reports the pull request an earlier Run opened. Only an _open_ pull request counts as existing: Task Branch names are derived from task text and truncated, so name reuse across time is expected, and reopening a merged one would re-propose commits the Base already has.

**Delivery happens only on a clean completion**, which here means the agent run returned rather than threw. It deliberately does not mean the completion signal fired: a Run passes the operator's task text verbatim at the default one iteration, so that signal is absent from almost every Run, and gating on it would mean nothing ever Delivered. A Run that failed does not Deliver even though its commits survive on the Task Branch — the Loop's gate is a merge, and a pull request from a half-finished Run spends that attention on work nobody claims is done. Re-dispatching continues the branch, and the Run that finishes the job Delivers.

## Delivery retries inside itself, and the Run's retry count stays zero

ADR 0002 sets the Orchestrator's retry count to 0 and says not to "fix" it. That still holds, and **Delivery's own bounded retry with backoff is that rationale applied rather than worked around**: the reason not to retry is that re-running a Run restarts the agent and burns subscription usage again, which is precisely why a transient push or API failure must not be allowed to discard twenty minutes of work the agent has already finished and committed. The retry is inside the Delivery, so no agent is ever re-run by it. Once the attempts are exhausted the Run fails, naming the branch, its commits and the cause. **A green Run with no pull request is the one outcome that must be impossible.**

## Delivery is not an Inngest step

The brief on #70 called for Delivery as its own Orchestrator step. It is not one, on evidence: an Inngest function containing a step is re-invoked once that step completes, with completed steps replayed from memoised state and **everything outside a step executed again**. The agent run is outside a step — the function has none today — so adding a step after it would re-run the agent on the replay invocation. That is the exact outcome ADR 0002 sets retries to zero to prevent, arrived at by a different route.

Wrapping the agent run in a step as well is the other way to close that gap, and is out of scope here by the brief's own division: it is a separate ticket, it buys no durability while retries are zero, and a `RunResult` carrying the agent's full stdout is a poor fit for a step output's size limit. Until that lands, Delivery is ordinary code inside the Run function, which is what the rest of the Run already is.

## Considered Options

- **Push and PR instructions appended to every task prompt** — cheap, and agent-dependent in the one way that matters: the Harness could not tell "nothing to commit" from "forgot to push", which is the failure this decision exists to remove.
- **Leaving it to the operator's task text** — the status quo, unreliable by construction.
- **A second Orchestrator function, triggered after the Run** — rejected: the Run's result has to carry the pull request URL, and a separate function cannot put it there.
- **Delivery as its own Inngest step** — what the brief asked for, rejected on evidence; see above. Wrapping the agent run in a step as well is the version that would work, and is a separate ticket.
- **The Base read from the checkout's `origin/HEAD`** — rejected: written once at clone time, so stale or absent on a checkout the platform has held for months.
- **Rebasing an existing Task Branch onto a newly named Base** — rejected outright as the work-eating class of surprise ADR 0001 exists to prevent. A conflicting Base refuses the Dispatch instead.
- **Force-pushing a Task Branch that diverged on the remote** — rejected for the same reason: a divergence is a legible failure, never a rewrite of commits already under review.

## Consequences

- Every Run Delivers. There is no per-Project opt-out, and auto-merge stays out of scope — the human gate is the merge (#9).
- The pull request's title is the first commit's subject. The agent had to satisfy the Project's own commit conventions to commit at all, so that subject is the one string on hand already known to pass a repository's title lint; truncated task text is a fallback, not a co-equal option.
- The pull request body carries the task text verbatim plus the Run's provenance, including the transcript as a **path on the Target**. #43 replaces that with a URL.
- No token reaches a command line, a remote URL, or git config: git authenticates through `GIT_ASKPASS`, which names `$GH_TOKEN`, and the GitHub API is called with a bearer header. Same rule as `GIT_SETUP_COMMAND` and the Onboarding scripts.
- A Project whose `origin` GitHub does not host cannot be Delivered to, and the Run says so before the agent starts rather than after. That is a new failure mode for a Project that previously produced a local Task Branch and nothing else — the deliberate consequence of every Run Delivering, with no per-Project opt-out.
- "Skipped" is reported in the failed Run's message rather than in a result, because a Run that throws has no result to carry it. The Limit Gate, which is the other reason a Run would not complete, is not yet implemented anywhere; when it lands it reaches this through the same path.
