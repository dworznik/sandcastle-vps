# CONTEXT

Ubiquitous language for sandcastle-vps. Glossary only — no implementation details.

## Terms

### Harness
The application this repo produces: a TypeScript CLI wrapping the sandcastle library. It runs on the VPS in its own container and is what a user (or automation) invokes to start a Run.

### Run
One invocation of an agent against a Project: a task description goes in, a Task Branch comes out. Executed by sandcastle inside a Sandbox. A Run is requested by a Dispatch and queued by the Orchestrator; it is never executed synchronously in the caller's process.

### Dispatch
The act of requesting a Run — an event carrying the Project and task description, sent by a human or by another agent. Dispatching is cheap and non-blocking; the caller does not wait for the Run.

### Orchestrator
The component that queues Dispatches, enforces concurrency limits, and records Run history and status. (Currently Inngest — but the term, not the vendor, is the domain concept.)

### Project
A git checkout on the VPS under the shared workspace root — the same checkout used interactively via claude-tmux sessions. A Project is the unit a Run targets.

### Task Branch
The named git branch where a Run's commits land. Agent work only ever becomes visible as a Task Branch; a Run never modifies a Project's HEAD or working tree.

### Sandbox
The isolated container sandcastle spawns for a single Run, containing the agent (Claude Code) and the Project's worktree. Ephemeral — exists only for the duration of the Run.

### Stack
This repo's own Docker Compose deployment on the VPS, independent of the claude-tmux stack, though it may share the VPS's workspace root and Docker daemon.

### Local Config
Machine-specific settings (VPS host, workspace root, tokens) kept out of version control — gitignored files seeded from committed examples. Two kinds: the Mac-side deploy target (SSH details) and the VPS-side runtime settings.
