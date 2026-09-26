# sandcastle-vps

An agent VPS you set up with one command: a Target that runs unattended agent Runs against your project checkouts, hosts the attended Sessions you work in yourself, and gives your own devices secure access to its services. The default install is the Run-only half, built on [sandcastle](https://github.com/mattpocock/sandcastle): a task description goes in; a `sandcastle/<slug>` Task Branch comes out — visible immediately in your live checkout, pushed, and proposed as a pull request. Sessions and access are enabled per Target, never by installing; see [ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md).

See `CONTEXT.md` for the domain language and `docs/adr/` for the load-bearing decisions (branch-only strategy on shared checkouts; Inngest with retries disabled; strict sandcastle conventions with per-project Onboarding; Delivery inside the Run; the Run Log kept by the Harness; the platform as the operator's agent VPS; WireGuard access to exposed services).

## Architecture

Two containers on the Target, neither reachable from outside it:

- **Orchestrator** — a self-hosted Inngest server. Queues Dispatches, serializes Runs per Project (concurrency 1), and records Run history. Dashboard on 8288.
- **Harness** — this repo's TypeScript app (`@ai-hero/sandcastle`), executing each Run: resolves the Project and the Run's Base, ensures its image, locks the branch strategy to a named Task Branch, and Delivers the result. It spawns each Sandbox as a sibling container through the Target engine's socket, and mounts the workspace root at the same path it has on the Target so those Sandboxes' bind mounts resolve. See [ADR 0006](docs/adr/0006-containerised-harness-and-installer-over-connectors.md).

A Run only targets an **Onboarded** Project — a checkout with its own committed `.sandcastle/` directory, whose own `sandcastle:<dir-name>` image runs the Sandbox. Dispatching to a checkout that was never Onboarded fails and tells you to Onboard it. When a Project's image is missing the Harness builds it once, and never rebuilds an existing one — so Dockerfile edits need a manual rebuild. See [ADR 0003](docs/adr/0003-strict-sandcastle-conventions-per-project-onboarding.md).

A Project carries no credentials. The agent's identity — Claude token, GitHub token, author name and email, and an ed25519 signing key — belongs to the Harness, which injects it into each Sandbox for the life of one Run: the tokens and author as environment, the key as a read-only mount, and git configured from them before the agent starts. Nothing is written into the Project checkout, and there is nothing to stamp or sync per Project. A Run that finds one of them missing refuses to start and names it rather than running unauthenticated. See [ADR 0006](docs/adr/0006-containerised-harness-and-installer-over-connectors.md).

Nothing listens on the public interface — nothing but WireGuard, on a Target where access is enabled. The Dispatch surface is keyless — reachability _is_ the access control. The two containers meet by service name on the compose network, and only two ports are published on the Target, both on loopback: the Dispatch surface and the dashboard. Every other listener stays inside its container. Remote access goes through an SSH tunnel, or over the VPN to the services deliberately exposed on it (never the Dispatch surface; see [ADR 0011](docs/adr/0011-wireguard-access-to-exposed-services.md)), and the install checks from the outside that nothing is listening where it shouldn't.

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

### 2. Credentials

The install goes straight on to capturing the agent's identity, because a Harness without it refuses every Run. It asks only for what the Target does not already hold, so an upgrade is silent once they are there.

- **Claude token** — runs `claude setup-token` on your machine when Claude Code is installed there, and reads the token out of its output; otherwise you paste one.
- **GitHub token** — opens the fine-grained token page and prints the exact permissions a Run needs (Contents, Pull requests and Issues read-write, Metadata read-only, scoped to your Project repos), then verifies what you paste against the API before accepting it. A token GitHub turns down is never written.
- **Author name and email** — defaulting to your own `git config`. The address has to be one GitHub has verified on your account, or commits arrive unattributed.
- **Signing key** — a passphraseless ed25519 key generated _on the Target_, so the private half never travels. Its public half is printed, GitHub's key page is opened, and the registration is confirmed through `gh api user/ssh_signing_keys` rather than by taking your word for it. Register it as a **signing** key: the same page adds authentication keys, and one of those signs nothing.

The two tokens are never echoed — not to the terminal, and not into readline's history, where the next prompt's up-arrow would have found them. Nothing asked for here is stored on your machine or passed as a command argument on either end: the environment file travels to the Target over stdin, and the GitHub check puts the token in a header rather than on a `curl` command line. The Target profile holds paths and a host, and never a secret.

The two GitHub pages are the only steps performed by hand. Replacing a credential that is already there is rotation, which is issue #37; re-running install/upgrade fills in whatever is still missing.

### 3. Onboard a Project

A checkout can only receive Runs once it's been Onboarded. Pick **Add a Project** from the menu and give it a repository, as `owner/name` or an `https://` URL.

Every step runs inside the Harness container, which is the point: it already holds the PAT in its environment, has git and the sandcastle CLI, mounts the workspace root at path parity, and runs as the operator who owns those checkouts. So the token never leaves the Target, and the CLI never handles it.

It clones over HTTPS through a one-shot credential helper — `-c` config, so the token never reaches the checkout's `.git/config`, and the remote stays HTTPS for a Sandbox to push through later. Then it scaffolds `.sandcastle/` with the real `sandcastle init --template blank`, appends this stack's extras fragment to the generated Dockerfile, and builds `sandcastle:my-app`. Commit the resulting `.sandcastle/`; it carries no credentials.

The fragment (`docker/sandbox/extras.Dockerfile`) adds what sandcastle's template does not: `openssh-client`, which is how a Run signs its commits; the skill set, baked in because a Sandbox has no volume to install into; and tmux, vim and bash. Those last three are for the Session, not the Sandbox — a Project's one image serves both (see [ADR 0007](docs/adr/0007-interactive-sessions-as-per-project-containers.md)), so what a Session needs to start a tmux server and edit a file is built once, here. bash is the Session's login shell, and zsh is deliberately not installed ([ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md)). A Sandbox is unaffected beyond image size. The fragment ends by switching back to the unprivileged agent user, as the template's own stage does.

Finally it asks the Harness what it can see. That answer is the one worth having — a checkout is visible on the Target's disk to anyone with a shell there, but only the Harness can say whether the path-parity mount and `WORKSPACE_ROOT` line up well enough for a Dispatch to resolve it.

A Project that is already Onboarded is not scaffolded over: the wizard says so and stops. A checkout you put under the workspace root yourself is Onboarded in place rather than cloned again.

### 4. Dispatch a Run

The Dispatch surface is published on the Target's loopback and nowhere else — reachability is the access control, so nothing behind it authenticates. `sandcastle-run` is delivered with the stack, under the install directory:

```bash
~/.sandcastle-vps/scripts/vps/sandcastle-run my-app "Fix the flaky login test" \
  [--branch sandcastle/login-test] [--base main] [--model claude-opus-4-8]
```

For a few seconds after the stack starts, the surface answers 503 with `Retry-After`: the Orchestrator accepts events before it has synced the Harness, and an event accepted then would never become a Run, so the Harness refuses to send one until the Orchestrator says it is synced. `sandcastle-run` waits that out for you; a caller posting directly should retry on 503.

It needs `curl` and `jq` on the Target. Nothing else does — install and Onboarding go through the Harness container — so if they aren't there, post to the surface directly instead:

```bash
curl -sS -X POST http://127.0.0.1:3000/dispatch \
  -H 'content-type: application/json' \
  -d '{"project":"my-app","task":"Fix the flaky login test"}'
```

Dispatching is non-blocking — the Run is queued by the Orchestrator, not executed in your shell. Commits land on the Task Branch; the Project's HEAD and working tree are never touched. Re-dispatching to the same branch resumes that Task Branch's worktree — that's how you iterate on a task.

The answer carries the Orchestrator's id for the Dispatch and, beside it, the URL of the Run's log page — `sandcastle-run` prints it as `Run logs: http://127.0.0.1:3000/runs/<id>`. The page exists from that moment and tails the Run live once it starts; see [Watch it](#5-watch-it).

A Run that completes then **Delivers**: it pushes the Task Branch and opens a pull request against the Run's **Base**, or updates the one that branch already has. The Base is what the branch is cut from as well as what its pull request targets; `--base` names it, and without one the Project remote's default branch is used. A re-dispatch keeps the Base the branch was cut from, and naming a conflicting one is refused rather than rebasing work that may already be under review.

The Run's result says which of four things happened — `delivered`, `updated`, `nothing-to-deliver`, or `skipped` because the Run did not complete — with the pull request URL on the first two and a reason on the last two. A Delivery that cannot be completed fails the Run and names the branch and its commits; a Run that reports success always has a pull request or a reason there is none. See [ADR 0008](docs/adr/0008-delivery-inside-the-run.md).

From anywhere else (your laptop, a Session on another Target), tunnel first and point the command at your end of it:

```bash
ssh -L 3000:127.0.0.1:3000 your-vps
SANDCASTLE_DISPATCH_URL=http://127.0.0.1:3000 sandcastle-run my-app "..."
```

### 5. Watch it

Every Run keeps its own log — its **Run Log** — under the Project, at `<project>/.sandcastle/runs/<id>/`, and the Harness serves it on the same loopback port as the Dispatch surface:

```bash
ssh -L 3000:127.0.0.1:3000 your-vps    # then open http://127.0.0.1:3000/runs/<id>
```

The page is one timeline: the Harness's phases (Base resolved, image ready, agent started, Delivery), one row per model call with a chip per tool call, the Sandbox's own hook events between them, and a subagent's work indented under the Agent call that spawned it. A summary band counts calls, tool calls and errors, shows the cost, and the subscription's five-hour and seven-day utilisation as Claude Code reports them. It polls every two seconds until the Run reports itself finished or failed, and any row opens to its full event. Behind it, each file is served under the same path: `events.jsonl` (what the page reads), `stream.jsonl` (Claude Code's raw `stream-json`, verbatim), `hooks.jsonl` (written from inside the Sandbox), `sandcastle.log` (sandcastle's own rendered log) and `session/` (the captured session transcript and its subagents' transcripts, which outlive the Harness container because they are here and not in its home).

The same URL is in the Run's result on the Orchestrator's run page — with a capped tail of the last events, and `truncated: true` when it was cut — in a failed Run's error message, and in the pull request body a Delivery writes. The Orchestrator itself records that a Run happened and how it ended; the Run Log is what happened inside it. See [ADR 0009](docs/adr/0009-run-log-kept-by-the-harness-and-linked-from-the-result.md).

The Orchestrator's dashboard has every Run's status and result:

```bash
ssh -L 8288:127.0.0.1:8288 your-vps    # then open http://127.0.0.1:8288
```

The Harness logs to its container:

```bash
docker compose logs -f harness    # on the VPS, in ~/.sandcastle-vps
```

### 6. Sessions

A **Session** is where you work on a Project yourself, rather than by Dispatching a Run: one long-lived container per Project, built from that Project's own image, whose tmux server you attach to. It is not a Sandbox — it may start one — and it survives you: drop the ssh connection, close the laptop, and the container and every tmux window in it are still there when you come back. See [ADR 0007](docs/adr/0007-interactive-sessions-as-per-project-containers.md).

**Enable.** Sessions are off after an install. Turn the `sessions` toggle on from **Sessions and access** (see below); it prints the trust rule first, because a Project you open a Session on runs its committed Dockerfile with the Docker socket available — root-equivalent on the Target. Onboard only repositories you control on a Target with Sessions on.

**Open.** Pick **Sessions** from the menu, then a Project. The first open starts the container — in its own compose project, so the install's `up --remove-orphans` can never reach it; on the platform network, so it resolves the Harness by name; with the workspace root mounted at path parity and the Docker socket available, so an agent inside can start a Sandbox — and every open, first or later, attaches you to the same tmux server inside it, over `ssh -t`, in the Project checkout with bash as the shell. Opening a Session on a Project that is already running attaches to it; there is never a second container.

**Detach.** tmux's own `C-b d`, or just close the connection. Nothing stops. **Stop** is a separate, explicit choice on the same menu, and it removes the container and its tmux windows together.

Four files are generated for each Project under `<install dir>/sessions/<project>/`, regenerated on every open: the compose file, an init script the container starts through, and a profile every login shell in it sources; plus a `.devcontainer/devcontainer.json` in the checkout pointing an editor at the same container — the only thing written into the repository, ignored from inside its own directory so the Project's `.gitignore` is untouched and an agent never sees it. A Project Onboarded before Sessions existed gets them all on its first open.

**Who commits, and who is logged in.** Inside a Session, git commits as the agent and Claude Code runs as you ([ADR 0007](docs/adr/0007-interactive-sessions-as-per-project-containers.md), narrowed by [ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md)). The container gets what a Sandbox gets for git — the GitHub token, the author name and email, and the signing key mounted read-only — and its init script configures git from them exactly as a Run does, so a commit made in a Session is authored and signed as the agent and verifies on GitHub, and `gh` is authenticated with the same token without it ever reaching the checkout's git config. The values are filled from the Target's `.env` when the container starts; the generated files hold names, never tokens.

The Claude credential is the exception. A Session must **not** carry `CLAUDE_CODE_OAUTH_TOKEN`, or Claude Code would take the Run token over your login and silently ignore it. Instead, one external Docker volume, `sandcastle-vps-claude`, is created when you enable `sessions` and mounted at `~/.claude` in every Session on the Target, and Claude Code is pointed at it, so a `claude auth login` done once in any Session serves every Project, refreshes itself, keeps your MCP logins, and survives stopping and starting Sessions. The Run token is still present, under the name `SANDCASTLE_RUN_TOKEN`, for the one thing that needs it: the profile wraps the `sandcastle` command so a Sandbox you start from a Session receives it as `CLAUDE_CODE_OAUTH_TOKEN`, and nothing else does. **A Workstation Target therefore holds two Claude credentials — your login and the Run token, both on the same subscription.** That is the cost ADR 0010 states, and `status` reports whether the login is there.

**First time on a fresh Workstation Target**, inside any Session — the platform runs none of this and seeds nothing into `~/.claude`:

```bash
claude auth login                              # once; every Session on this Target is then logged in
claude plugin install claude-mem@thedotmack    # the Memory service runs this plugin out of the volume
claude plugin install <…>                      # the other plugins you use; the image carries only skills
```

**Memory.** One claude-mem worker serves every Session on the Target — not one per container, which would be N writers on one SQLite file ([ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md)). It comes up with the `sessions` toggle and goes down with it, as its own compose project, `sandcastle-vps-memory`, on the platform network, where a Session reaches it as `memory`. The platform ships only the runtime — bun, the `claude` CLI and uv for Chroma's Python, in `docker/memory/` — and the container mounts the same `sandcastle-vps-claude` volume the Sessions do and runs the _installed plugin's own_ worker script out of it. So plugin and worker cannot drift: install the plugin once from any Session, as above, and update it there too; a restart of the service (`docker compose restart` in `<install dir>/memory`, or disabling and enabling `sessions`) runs whatever version is installed, and `status` reports the version the worker answers with. Until the plugin is installed the service waits, saying so in its log every minute, rather than crash-looping; `status` says the same. The worker summarises unattended, so it gets the Run token like a Run does — the one container on a Workstation Target besides a Sandbox that carries `CLAUDE_CODE_OAUTH_TOKEN`. Its store is a named volume, `sandcastle-vps-memory`, unless `MEMORY_DATA_DIR` in the Target's `.env` names a directory to use as is, which is how an existing claude-mem store is kept at cutover. Runs never write to it: a Run's memory is its Run Log. A Session's hooks reach it without a setting changed: the plugin checks health on `127.0.0.1:37777` and nowhere else, and starts a worker of its own when nothing answers there, so every Session runs a loopback forwarder — a small socat sidecar sharing the session container's network namespace, in the same compose project — that answers on that address and carries each connection to `memory` over the platform network. No worker ever runs inside a Session; observations from every Project land in the one store, kept apart by path parity; and the worker's admin routes, which accept only its own loopback, refuse a restart asked for from a Session, which is right for a shared service. A Sandbox has no forwarder and writes nothing to Memory. One caveat: the sidecar shares the session container's namespace, so restart the Session's compose project (or stop and open the Session again) rather than the session container alone.

**What persists.** A Session's shell state outlives its container, the Project's image, and an upgrade: a second external volume, `sandcastle-vps-session-state`, mounted at `~/.session-state` in every Session on the Target, holds your bash history (in bash's own format, appended as you type, so a window that dies with the container keeps what was typed in it) and, if you put them there, a `.bashrc` and a `.tmux.conf`. The Session's startup files source the `.bashrc` after the image's own, so yours wins, and link `~/.tmux.conf` to the volume's; remove either and the Session is back on the image's defaults. Both files are shared by every Project's Session, as the login is. A tmux config is seeded into the volume once, when none exists, and from that moment it is yours: edit it and the edits survive every start and upgrade; delete it and nothing writes it again. That seed is the one thing the platform ever writes into your config ([ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md)); a Session start otherwise changes nothing in the volume, which you can check by diffing it. The login shell inside a Session is bash. claude-tmux's zsh history is not carried over, by decision.

Attaching needs a terminal on both ends, which the ssh Connector provides; a kind of Target with no terminal to offer says so and leaves the Session running for you to reach another way.

### 7. Status, toggles, and rotating credentials

**Status** answers "what is actually running on this Target, and is it the version I have", and changes nothing — it can be run against a Target mid-Run without thinking about it. Every question goes to whatever owns the answer: the Orchestrator for what synced, the Harness for the Projects it can see, the Target's own kernel for what is listening. It reports the package version on the Target against the CLI's own, which is the usual explanation for "but I fixed that"; the Target's **posture** — a Run-only Target, or a Workstation Target once `sessions` is on — with the state of the `sessions` and `access` toggles beside it; which credentials are missing, since a Target can look healthy and still refuse every Run; each Project and whether its image is built; each running Session, found through the engine because Sessions live outside the stack's compose project; the containers; and the platform network — one Docker network, `sandcastle-vps`, that the install creates and the stack joins, and that a Project's Session and the Memory service later join by name from their own compose projects ([ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md)). A Target installed before the network existed is reported as missing it; the next install/upgrade creates it and moves the stack onto it with nothing to do by hand. Against a Target this CLI has never installed to, it says so plainly instead of failing obscurely.

**Sessions and access** flips the two per-Target toggles of [ADR 0010](docs/adr/0010-the-platform-is-the-operators-agent-vps.md). Both are off after an install, recorded in the Target's own `.env` as `SESSIONS_ENABLED` and `ACCESS_ENABLED` — never in your profile — and both survive an upgrade like every other value in that file. `sessions` turns the Target into a Workstation Target; enabling it first prints the trust rule from [ADR 0007](docs/adr/0007-interactive-sessions-as-per-project-containers.md) and asks, because a Project you open a Session on runs its committed Dockerfile with the Docker socket available. `access` is independent: a Run-only Target with its dashboard reachable from your phone is a real configuration. Today the toggles record state and drive **Status**; attaching Sessions, the Memory service and Access to them is the work under issue #72.

**Status** also has an Access section: off, or on with the WireGuard UDP port shown as the one intended public listener, each Peer by name and tunnel address, and where each Exposed Service is reached. See [Access](#7-access).

**Rotate credentials** replaces what the Target already holds. Pick any of the four credentials and the signing key; it re-asks for those, rewrites the environment file, and restarts the Harness. It is one action rather than a walk over every Project, because there is one place credentials live — the retired `sync-env` existed only because there were N copies to keep aligned.

Rotating the signing key regenerates it on the Target and waits for the new one to be registered before finishing. The new key is generated beside the old one and moved into place, so a rotation that fails partway leaves the Target with the key it had. The old private half is then gone, and its registration on GitHub is stale — remove it there once the new one is in.

Rotation is also the way out of a signing key the install refuses to keep: one with a passphrase, or of the wrong type.

### 8. Access

Access is a WireGuard VPN on the Target, provisioned and managed by the CLI, through which your own devices reach the Target's Exposed Services by plain HTTP at the tunnel address — no SSH tunnel per session, no certificate or login per service. It is a per-Target toggle, independent of Sessions: a Run-only Target with its dashboard reachable from your phone is a real configuration. See [ADR 0011](docs/adr/0011-wireguard-access-to-exposed-services.md).

**Enable it** from **Sessions and access**. The first time, the wizard asks for the address your devices will reach the Target at — a public hostname or IP, defaulting to the host in the Target profile; an OrbStack machine has none a phone can reach, so give it whatever you use — and records it in the Target's `.env`. It then writes the Access service's compose project under `<install dir>/access/`, builds the image the package delivers, and starts WireGuard on `udp/51820` (pin `ACCESS_PORT` to change it). The server key is generated on the Target on first start and kept in a Docker volume, so it survives a restart, an upgrade, and disabling and enabling again. Disabling stops the service and keeps the key.

**Add a Peer** from the menu, giving the device a name. The keypair is generated on the Target inside the Access container; the Target records the public half and the device's tunnel address in `access/peers.conf`, restarts the service to pick it up, and then hands you the config once — as a QR code to scan from the WireGuard app on a phone, rendered on the Target so nothing needs installing here, or as a file written at mode 600 for a laptop. The private key is not kept anywhere: not on the Target, not by the CLI. Peer names are unique per Target; a second device under a name already recorded is refused rather than silently replacing the first.

**Revoke a Peer** from the same menu, by name. The Peer is removed from `access/peers.conf` and dropped from the running interface with `wg set`, so its config stops connecting at once and the other Peers' tunnels are not touched — nothing restarts. A name that is not recorded is said so, and nothing changes. If the service is not running at the time, the Peer is still gone from the record, which is what the interface is built from on its next start, so it is never admitted again.

**Status** shows whether access is on, that WireGuard is the one listener on the public interface and on which port, every Peer by name with its tunnel address and the date it was added, and each Exposed Service as the private address and port a connected device reaches it at — so what a device holding a config can reach is readable from `status` alone.

**What is exposed** is an allowlist, not a bind. The service drops all forwarding by default; the CLI writes `access/allowlist` from its Exposed Service list, and the entrypoint adds one DNAT rule per entry from the tunnel address to that service on the platform network. So "exposed" means "in the allowlist", and nothing becomes reachable by accident. On day one the list holds the Orchestrator dashboard, at `http://10.13.13.1:8288` from a connected Peer. The Dispatch surface is never in it — it is keyless by design, and a test asserts the writer refuses it. A Peer's config routes only the tunnel subnet, so the device's other traffic is untouched. If the dashboard stops answering after the stack was recreated, disable and enable access: the rules resolve service addresses when the service starts.

**DNS is optional.** Without a domain, Peer configs carry the address you gave when enabling access, and services are printed by tunnel address — which is what an OrbStack Target with no public address needs. With a domain on Cloudflare, pick **Set up DNS** from the Access menu: it asks for the zone, a public name for the Target (`<target>.<zone>` by default) and an internal name for the tunnel address (`<target>.in.<zone>`), and once for an API token with Zone:Read and DNS:Edit on that zone. The token goes into the Target's `.env` over stdin like every other credential, never on a command line or in a script on either end, and is not kept on your machine. The CLI then writes both A records through the token from inside the Access container — the public one at the Target's current public address, the internal one at `10.13.13.1`, both unproxied, since a WireGuard endpoint is UDP and cannot go through Cloudflare's proxy — and adds a ddclient container to the Access project that keeps the public record following the Target's address. From then on a new Peer's config dials the public name, a Peer added before keeps working by address, and `status` and the Peer-add output print each Exposed Service as `http://<internal name>:<port>`. That the private tunnel address appears in public DNS is accepted, as ADR 0011 records. Without a domain, `status` says DNS is not configured.

**The trade-off**, stated as ADR 0011 records it: access is network-level, not identity-level. Anyone holding a Peer config reaches every Exposed Service, and one public listener now exists — WireGuard's UDP port — on a Target where access is enabled. The install's exposure check is unchanged by it: it reads TCP listen tables, WireGuard is UDP, and DNAT creates no listener.

## Development

```bash
pnpm install
pnpm typecheck && pnpm test
```

## Releasing

A version tag on `main` is the release. Bump `version` in `package.json` through a pull request, then tag the squash commit and push the tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/publish.yml` runs the same checks as CI, refuses a tag whose version differs from `package.json` or whose commit is not on `main`, and publishes to npm with provenance. It authenticates with npm's trusted publishing, which is configured once on npmjs.com under the package's settings: the GitHub repository `dworznik/sandcastle-vps` and the workflow file `publish.yml`. Trusted publishing can only be configured for a package that already exists, so the first publish ever uses a granular access token in an `NPM_TOKEN` repository secret, which is deleted once the trusted publisher is in place.
