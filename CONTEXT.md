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
A git checkout on the VPS, under the workspace root, that has been Onboarded. Only Projects can be targeted by a Run. Each Project owns its Sandbox definition and credentials — there is no shared fallback.

### Onboarding
The one-time act of making a checkout a Project: scaffolding its sandcastle configuration, granting it credentials, and building its Sandbox image. A checkout that has not been Onboarded cannot receive Dispatches.

### Task Branch
The named git branch where a Run's commits land. Agent work only ever becomes visible as a Task Branch; a Run never modifies a Project's HEAD or working tree. Re-dispatching to an existing Task Branch continues that task.

### Sandbox
The isolated container sandcastle spawns for a single Run, containing the agent (Claude Code) and the Project's worktree. Ephemeral — exists only for the duration of the Run — and built from the Project's own image, never a shared one.

### Local Config
Machine-specific settings kept out of version control. Three layers: the deploy target (on the operator's machine), the Harness's runtime settings (on the VPS), and each Project's own credentials (inside that Project's checkout).
