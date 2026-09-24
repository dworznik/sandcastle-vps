# CONTEXT

Ubiquitous language for sandcastle-vps. Glossary only — no implementation details.

## Terms

### Harness

The application this repo produces: a service wrapping the sandcastle library that executes Runs. It runs on the VPS and is what a Dispatch ultimately reaches.

### Run

One invocation of an agent against a Project: a task description goes in, a Task Branch comes out. Executed by sandcastle inside a Sandbox. A Run is requested by a Dispatch and queued by the Orchestrator; it is never executed synchronously in the caller's process.

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

### Sandbox

The isolated container sandcastle spawns for a single Run, containing the agent (Claude Code) and the Project's worktree. Ephemeral — exists only for the duration of the Run — and built from the Project's own image, never a shared one. Distinct from a Session, which is attended and outlives any one agent invocation.

### Session

An attended terminal on a Project, in a long-lived container built from that Project's image, where the operator works with their own identity. One per Project; sessions are tmux windows inside it, so they survive a dropped connection. A Session is not a Sandbox — it may start one.

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

A Target that also hosts Sessions. It holds no additional credentials at rest — the operator's identity is forwarded for the life of a connection — but it exposes the Docker socket to session containers, so it is a machine the operator must trust. Enabled deliberately, never by installing.

### Connector

How the creator CLI reaches a Target from the operator's machine: ssh, OrbStack, Docker Desktop, or a Docker context. A Connector delivers the package, runs commands, and performs checks; it is the only thing that differs between kinds of Target.
