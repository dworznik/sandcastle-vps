# sandcastle-vps

A [sandcastle](https://github.com/mattpocock/sandcastle) harness for the VPS: dispatch background agent Runs against the project checkouts you already work on in [claude-tmux](https://github.com/dworznik/claude-tmux) sessions. A task description goes in, a `sandcastle/<slug>` Task Branch comes out — visible immediately in your live checkout.

See `CONTEXT.md` for the domain language and `docs/adr/` for the load-bearing decisions (branch-only strategy on shared checkouts; Inngest with retries disabled; strict sandcastle conventions with per-project Onboarding).

## Architecture

Two pieces on the VPS, both bound to loopback:

- **Orchestrator** — a self-hosted Inngest server, the one thing still in this repo's compose stack. Queues Dispatches, serializes Runs per Project (concurrency 1), and records Run history. Dashboard on 8288.
- **Harness** — this repo's TypeScript app (`@ai-hero/sandcastle`), running as a **systemd user service** on the host rather than in a container, because that is where Docker and the Project checkouts natively live. It executes each Run: resolves the Project, ensures its image, and locks the branch strategy to a named Task Branch.

A Run only targets an **Onboarded** Project — a checkout with its own committed `.sandcastle/` directory. That Project's own `sandcastle:<dir-name>` image runs the Sandbox, and its own `.sandcastle/.env` supplies the agent token; the Harness holds neither. Dispatching to a checkout that was never Onboarded fails and tells you to Onboard it. When a Project's image is missing the Harness builds it once, and never rebuilds an existing one — so Dockerfile edits need a manual rebuild. See [ADR 0003](docs/adr/0003-strict-sandcastle-conventions-per-project-onboarding.md).

Nothing listens on the public interface. The Dispatch surface is keyless — reachability *is* the access control — so both halves bind `127.0.0.1` and remote access goes through an SSH tunnel.

## Lifecycle

### 1. Deploy

```bash
cp deploy.local.example deploy.local   # set SSH_TARGET=user@your-vps
./scripts/deploy.sh
```

One command takes a fresh VPS to a running stack: it uploads the repo to `~/.sandcastle-vps`, installs Node 22 (user-local via nvm, no root) if it's missing, installs dependencies, seeds `~/.sandcastle-vps/.env`, starts the Orchestrator, installs and starts the Harness service with lingering enabled so it survives a reboot, and puts the host commands on your `PATH`.

Re-running is idempotent and never overwrites an existing `.env` value. The first deploy stops and asks you to fill in `WORKSPACE_ROOT` only if it can't be auto-detected from claude-tmux; Inngest keys are generated for you. Agent tokens are not in this file — they live in each Project's own `.sandcastle/.env`.

### 2. Onboard a Project

A checkout can only receive Runs once it's been Onboarded. On the VPS host:

```bash
claude setup-token | init-project my-app
```

That scaffolds `.sandcastle/` with the real `sandcastle init`, appends this stack's skill set to the generated Dockerfile, seeds `.sandcastle/.env` with the token, and builds `sandcastle:my-app`. Commit the resulting `.sandcastle/` — its `.gitignore` already excludes the `.env`. Re-running on an Onboarded Project fails rather than overwriting your customizations.

The token is never stored centrally: it's supplied per invocation, and the only copies live in each Project's own `.sandcastle/.env`. To roll a reissued token across every Onboarded Project at once:

```bash
claude setup-token | sync-env
```

### 3. Dispatch a Run

On the VPS host:

```bash
sandcastle-run my-app "Fix the flaky login test" [--branch sandcastle/login-test] [--model claude-opus-4-8]
```

Dispatching is non-blocking — the Run is queued by the Orchestrator, not executed in your shell. Commits land on the Task Branch; the Project's HEAD and working tree are never touched. Re-dispatching to the same branch resumes that Task Branch's worktree — that's how you iterate on a task.

From anywhere else (your laptop, a claude-tmux dev container), tunnel first and point the command at your end of it:

```bash
ssh -L 3000:127.0.0.1:3000 your-vps
SANDCASTLE_DISPATCH_URL=http://127.0.0.1:3000 sandcastle-run my-app "..."
```

### 4. Watch it

```bash
ssh -L 8288:127.0.0.1:8288 your-vps    # then open http://127.0.0.1:8288
```

The Harness logs to the journal:

```bash
systemctl --user status sandcastle-harness
journalctl --user -u sandcastle-harness -f
```

## Development

```bash
pnpm install
pnpm typecheck && pnpm test
```
