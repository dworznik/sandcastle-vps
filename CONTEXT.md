# CONTEXT

Ubiquitous language for sandcastle-vps. Glossary only — no implementation details.

## Terms

### Harness

The application this repo produces: a service wrapping the sandcastle library that executes Runs. It runs on the VPS and is what a Dispatch ultimately reaches.

### Run

One invocation of an agent against a Project: a task description goes in, a delivered Task Branch comes out. Executed by sandcastle inside a Sandbox. A Run is requested by a Dispatch and queued by the Orchestrator; it is never executed synchronously in the caller's process. A Run that completes its work also Delivers it — the two are one unit, and a Run that produced work but did not Deliver it is a failed Run.

### Dispatch

The act of requesting a Run — an event carrying the Project and task description, sent by a human or by another agent. Dispatching is cheap and non-blocking; the caller does not wait for the Run.

### Orchestrator

The component that queues Dispatches, enforces concurrency limits, and records Run history and status. (Currently Inngest — but the term, not the vendor, is the domain concept.)

### Project

A git checkout on the VPS, under the workspace root, that has been Onboarded. Only Projects can be targeted by a Run. Each Project owns its Sandbox definition — there is no shared fallback.

### Onboarding

The one-time act of making a checkout a Project: scaffolding its sandcastle configuration and building its Sandbox image. A checkout that has not been Onboarded cannot receive Dispatches. Credentials are not part of it — the Harness holds them and injects them per Run.

### Task Branch

The named git branch where a Run's commits land. Agent work only ever becomes visible as a Task Branch; a Run never modifies a Project's HEAD or working tree. Re-dispatching to an existing Task Branch continues that task.

### Delivery

Publishing a completed Run's Task Branch as a pull request: the branch reaches the Project's remote, and a pull request proposes it against the Run's base. Delivery is what turns agent work into something the Loop's human gate can act on, so it belongs to the Run rather than to a later step. It can succeed or fail independently of the agent's work — a Run whose agent finished and whose Delivery failed has commits and no pull request, which is a failure and must read as one.

### Base

The branch a Run's work is proposed against: what its Task Branch is cut from, and what its Delivery opens the pull request against. A Base is an input to a Run, defaulting to the Project remote's default branch — never inherited from whatever branch the shared checkout happens to be sitting on.

### Run Log

Everything kept about one Run: the phases the Harness took it through, what the agent did inside the Sandbox, and the session transcript. Kept by the Harness under the Project and reachable by the id the Dispatch answered with, so the link exists before the Run starts. The Orchestrator records that a Run happened and how it ended; the Run Log records what happened inside it.

### Sandbox

The isolated container sandcastle spawns for a single Run, containing the agent (Claude Code) and the Project's worktree. Ephemeral — exists only for the duration of the Run — and built from the Project's own image, never a shared one. Distinct from a Session, which is attended and outlives any one agent invocation.

### Session

An attended terminal on a Project, in a long-lived container built from that Project's image, where the operator works directly rather than by Dispatching a Run. One per Project; sessions are tmux windows inside it, so they survive a dropped connection. A Session is not a Sandbox — it may start one. Its commits sign with the agent's key, like a Run's.

### Loop

The autonomous cycle that carries an issue from `ready-for-agent` to a merged pull request without a human at each step: triage, Dispatch, delivery, review, and repair. The human's only gates are filing the issue and merging the pull request.

### Phase

Where an issue sits in the Loop at a given moment — awaiting Dispatch, running, awaiting review, repairing, escalated. A Phase is what the Loop reads to decide its next action; it is not a Run's execution status, and no Orchestrator reports it.

### Limit Gate

The account-wide point past which no Run may start, because the Claude subscription's usage window is exhausted. The quota is shared across every Project, so the gate defers all queued Dispatches — not only the Run that hit the limit.

### Local Config

Machine-specific settings kept out of version control. Two layers: the Target profile on the operator's machine (never a secret), and the Harness's runtime settings on the Target, which include the agent's credentials.

### Target

A machine or container engine the platform is installed on — a VPS, an OrbStack machine, the operator's own Docker Desktop — reached only through a Connector. The Harness, the Orchestrator, the workspace root and the credentials all live on the Target.

### Run-only Target

A Target that executes Runs and nothing else. It holds agent credentials only, so the worst a compromise yields is push access to the Projects. What a default install produces.

### Workstation Target

A Target that also hosts Sessions. It holds no credentials a Run-only Target does not; what sets it apart is that it exposes the Docker socket to containers built from Projects' own Dockerfiles, which makes it a machine the operator must trust. Enabled deliberately, never by installing.

### Connector

How the creator CLI reaches a Target from the operator's machine: ssh, OrbStack, Docker Desktop, or a Docker context. A Connector delivers the package, runs commands, and performs checks; it is the only thing that differs between kinds of Target.
