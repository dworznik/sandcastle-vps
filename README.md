# sandcastle-vps

A [sandcastle](https://github.com/mattpocock/sandcastle) harness for the VPS: dispatch background agent Runs against the project checkouts you already work on in [claude-tmux](https://github.com/dworznik/claude-tmux) sessions. A task description goes in, a `sandcastle/<slug>` Task Branch comes out — visible immediately in your live checkout.

See `CONTEXT.md` for the domain language and `docs/adr/` for the load-bearing decisions (branch-only strategy on shared checkouts; Inngest with retries disabled; strict sandcastle conventions with per-project Onboarding).

## Architecture

Two containers, deployed as this repo's own compose stack on the VPS:

- **inngest** — self-hosted Inngest server (the Orchestrator): queues Dispatches, serializes Runs per Project (concurrency 1), records run history. Dashboard on port 8288 — reachable over the claude-tmux WireGuard VPN (`sandcastle-inngest:8288`) or an SSH tunnel to `127.0.0.1:8288`.
- **harness** — the Inngest app (TypeScript, `@ai-hero/sandcastle`). Executes each Run: resolves the Project by directory name under the shared workspace root, spawns a sibling sandbox container via the mounted Docker socket, and locks the branch strategy to a named Task Branch.

A Run only targets an **Onboarded** Project — a checkout with its own committed `.sandcastle/` directory. That Project's own `sandcastle:<dir-name>` image runs the sandbox, and its own `.sandcastle/.env` supplies the agent token; the harness holds neither. Dispatching to a checkout that was never Onboarded fails and tells you to onboard it. When a Project's image is missing, the harness builds it once via `sandcastle docker build-image`; it never rebuilds an existing image, so Dockerfile edits need a manual rebuild. See `docs/adr/0003-strict-sandcastle-conventions-per-project-onboarding.md`.

## Deploy

```bash
cp deploy.local.example deploy.local   # set SSH_TARGET=user@your-vps
./scripts/deploy.sh
```

The first deploy stops and asks you to fill the remote `~/.sandcastle-vps/.env` if the workspace root can't be auto-detected from claude-tmux; Inngest keys are auto-generated. Re-run to finish. Subsequent deploys are one command. Agent tokens are not part of this file — they live in each Project's `.sandcastle/.env`.

## Dispatch a Run

On the VPS host, or inside a claude-tmux session (both keyless — the harness holds the event key):

```bash
sandcastle-run my-app "Fix the flaky login test" [--branch sandcastle/login-test] [--model claude-opus-4-8]
```

Re-dispatching to the same branch resumes that branch's worktree — that's how you iterate on a task.

## Development

```bash
pnpm install
pnpm typecheck && pnpm test
```
