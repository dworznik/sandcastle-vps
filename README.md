# sandcastle-vps

A [sandcastle](https://github.com/mattpocock/sandcastle) harness for the VPS: dispatch background agent Runs against the project checkouts you already work on in [claude-tmux](https://github.com/dworznik/claude-tmux) sessions. A task description goes in, a `sandcastle/<slug>` Task Branch comes out — visible immediately in your live checkout.

See `CONTEXT.md` for the domain language and `docs/adr/` for the load-bearing decisions (branch-only strategy on shared checkouts; Inngest with retries disabled; strict sandcastle conventions with per-project Onboarding).

## Architecture

Two containers on the Target, neither reachable from outside it:

- **Orchestrator** — a self-hosted Inngest server. Queues Dispatches, serializes Runs per Project (concurrency 1), and records Run history. Dashboard on 8288.
- **Harness** — this repo's TypeScript app (`@ai-hero/sandcastle`), executing each Run: resolves the Project, ensures its image, and locks the branch strategy to a named Task Branch. It spawns each Sandbox as a sibling container through the Target engine's socket, and mounts the workspace root at the same path it has on the Target so those Sandboxes' bind mounts resolve. See [ADR 0006](docs/adr/0006-containerised-harness-and-installer-over-connectors.md).

A Run only targets an **Onboarded** Project — a checkout with its own committed `.sandcastle/` directory, whose own `sandcastle:<dir-name>` image runs the Sandbox. Dispatching to a checkout that was never Onboarded fails and tells you to Onboard it. When a Project's image is missing the Harness builds it once, and never rebuilds an existing one — so Dockerfile edits need a manual rebuild. See [ADR 0003](docs/adr/0003-strict-sandcastle-conventions-per-project-onboarding.md).

A Project carries no credentials. The agent's identity — Claude token, GitHub token, author name and email, and an ed25519 signing key — belongs to the Harness, which injects it into each Sandbox for the life of one Run: the tokens and author as environment, the key as a read-only mount, and git configured from them before the agent starts. Nothing is written into the Project checkout, and there is nothing to stamp or sync per Project. A Run that finds one of them missing refuses to start and names it rather than running unauthenticated. See [ADR 0006](docs/adr/0006-containerised-harness-and-installer-over-connectors.md).

Nothing listens on the public interface. The Dispatch surface is keyless — reachability _is_ the access control. The two containers meet by service name on the compose network, and only two ports are published on the Target, both on loopback: the Dispatch surface and the dashboard. Every other listener stays inside its container. Remote access goes through an SSH tunnel, and the install checks from the outside that nothing is listening where it shouldn't.

![Where every container lives across the dev machine, the OrbStack stand-in and the VPS](docs/diagrams/host-topology.svg)

More in [`docs/diagrams/`](docs/diagrams/), including what lasts one Run and what doesn't.

## Lifecycle

### 1. Install

On your own machine, with no checkout of this repo:

```bash
npx @dworznik/sandcastle-vps
```

The wizard asks how the Target is reached, checks it (Docker, the compose plugin, the `docker` group, disk, architecture — printing the exact command for anything missing, and offering to run it where elevation needs no password), then delivers this package to the Target, builds the Harness image there, writes the Target's `.env` at mode 600 with Inngest keys generated on the Target, and brings the stack up.

Then it checks the result from here, which is the half a deploy running on the Target could never do honestly: that the Harness has synced in the Orchestrator, that nothing on the Target is listening off loopback, and that a Dispatch to a Project that does not exist answers 400.

Re-running upgrades in place. It is idempotent: an existing `.env` value is seeded, never overwritten — so a captured credential and a hand-edited setting both survive an upgrade, and a value this install would have written differently is reported rather than applied.

**Prerequisites.** Your machine needs Node and `ssh`. The Target needs Docker Engine with the compose plugin, and your user in its `docker` group — the preflight names anything that is missing, and needs nothing else installed: it does not require rsync, curl, or iproute2 on either end.

<details>
<summary>The interim deploy from a checkout</summary>

```bash
cp deploy.local.example deploy.local   # set SSH_TARGET=user@your-vps
./scripts/deploy.sh
```

Superseded by the CLI above and retired by issue #38. It uploads the repo with rsync, seeds `~/.sandcastle-vps/.env`, builds the Harness image and brings both containers up — but it cannot capture credentials, so the stack it leaves cannot execute a Run. It needs `rsync`, `jq`, `curl`, `openssl`, `iproute2` and `git` on the VPS, and `ssh` and `rsync` on yours.

</details>

### 2. Credentials

The install goes straight on to capturing the agent's identity, because a Harness without it refuses every Run. It asks only for what the Target does not already hold, so an upgrade is silent once they are there.

- **Claude token** — runs `claude setup-token` on your machine when Claude Code is installed there, and reads the token out of its output; otherwise you paste one.
- **GitHub token** — opens the fine-grained token page and prints the exact permissions a Run needs (Contents, Pull requests and Issues read-write, Metadata read-only, scoped to your Project repos), then verifies what you paste against the API before accepting it. A token GitHub turns down is never written.
- **Author name and email** — defaulting to your own `git config`. The address has to be one GitHub has verified on your account, or commits arrive unattributed.
- **Signing key** — a passphraseless ed25519 key generated _on the Target_, so the private half never travels. Its public half is printed, GitHub's key page is opened, and the registration is confirmed through `gh api user/ssh_signing_keys` rather than by taking your word for it. Register it as a **signing** key: the same page adds authentication keys, and one of those signs nothing.

Nothing you type is echoed, stored on your machine, or passed as a command argument on either end — the environment file travels to the Target over stdin, and the GitHub check puts the token in a header rather than on a `curl` command line. The Target profile holds paths and a host, and never a secret.

The two GitHub pages are the only steps performed by hand. Replacing a credential that is already there is rotation, which is issue #37; re-running install/upgrade fills in whatever is still missing.

### 3. Onboard a Project

A checkout can only receive Runs once it's been Onboarded. On the VPS host:

```bash
claude setup-token | init-project my-app
```

That scaffolds `.sandcastle/` with the real `sandcastle init`, appends this stack's skill set to the generated Dockerfile, and builds `sandcastle:my-app`. Commit the resulting `.sandcastle/`. Re-running on an Onboarded Project fails rather than overwriting your customizations.

The token it seeds into `.sandcastle/.env` is no longer read by a Run — credentials are the Harness's now — and both this command and `sync-env` move into the wizard with issues #36 and #38.

### 4. Dispatch a Run

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

### 5. Watch it

```bash
ssh -L 8288:127.0.0.1:8288 your-vps    # then open http://127.0.0.1:8288
```

The Harness logs to its container:

```bash
docker compose logs -f harness    # on the VPS, in ~/.sandcastle-vps
```

## Development

```bash
pnpm install
pnpm typecheck && pnpm test
```
