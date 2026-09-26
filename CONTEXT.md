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

The named git branch where a Run's commits land. Agent work only ever becomes visible as a Task Branch; a Run never modifies a Project's HEAD or working tree. Re-dispatching to an existing Task Branch continues that task. Named as a human would name a branch, by type and description; one that the Watcher dispatched for an issue ends in that issue's number, which is how the Loop recognises it.

### Delivery

Publishing a completed Run's Task Branch as a pull request: the branch reaches the Project's remote, and a pull request proposes it against the Run's base. Delivery is what turns agent work into something the Loop's human gate can act on, so it belongs to the Run rather than to a later step. It can succeed or fail independently of the agent's work — a Run whose agent finished and whose Delivery failed has commits and no pull request, which is a failure and must read as one.

### Base

The branch a Run's work is proposed against: what its Task Branch is cut from, and what its Delivery opens the pull request against. A Base is an input to a Run, defaulting to the Project remote's default branch — never inherited from whatever branch the shared checkout happens to be sitting on.

### Run Log

Everything kept about one Run: the phases the Harness took it through, what the agent did inside the Sandbox, and the session transcript. Kept by the Harness under the Project and reachable by the id the Dispatch answered with, so the link exists before the Run starts. The Orchestrator records that a Run happened and how it ended; the Run Log records what happened inside it.

### Sandbox

The isolated container sandcastle spawns for a single Run, containing the agent (Claude Code) and the Project's worktree. Ephemeral — exists only for the duration of the Run — and built from the Project's own image, never a shared one. Distinct from a Session, which is attended and outlives any one agent invocation.

### Session

The long-lived container on a Project, built from that Project's image, in which the operator works directly rather than by Dispatching a Run — the thing one attaches to. One per Project. The terminals inside it are windows of its multiplexer, so they survive a dropped connection; a window is not a Session, and there are never two Sessions on one Project. A Session is not a Sandbox — it may start one. Its commits sign with the agent's key, like a Run's; the operator's Claude Code inside it uses the operator's own login.
_Avoid_: window, tmux session

### Watcher

The part of the Harness that turns a ready issue into a Dispatch: it polls each watched Project's tracker on a schedule, recognises the issues that are eligible, and dispatches each one's first Run. It never runs a second Run on an issue; later Runs belong to the Loop's review and repair Phases.

### Brief

The comment a triager leaves on an issue to make it ready for an agent: the distilled contract the Run is dispatched with. An issue without one is not eligible, whatever its label says.

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

A Target that also hosts Sessions and the Memory. Two things set it apart from a Run-only Target, and both are why the operator must trust it: it holds the operator's own Claude login, and it exposes the Docker socket to containers built from Projects' own Dockerfiles. Enabled deliberately, never by installing.

### Memory

The one store of what the agent observed across Sessions on a Target, and the service that keeps it. Shared by every Session; kept distinct per Project. A Run does not write to it — a Run's record is its Run Log.

### Access

The private network through which the operator's own devices reach a Target's Exposed Services without a login on each. Enabled per Target, independently of Sessions; a Run-only Target may have it.

### Peer

One of the operator's devices admitted to a Target's Access. Added and revoked one at a time; the Target keeps the list.

### Exposed Service

A service on the Target reachable over Access. Nothing is exposed unless it is listed; the Dispatch surface is never listed.

### Connector

How the creator CLI reaches a Target from the operator's machine: ssh, OrbStack, Docker Desktop, or a Docker context. A Connector delivers the package, runs commands, and performs checks; it is the only thing that differs between kinds of Target.
