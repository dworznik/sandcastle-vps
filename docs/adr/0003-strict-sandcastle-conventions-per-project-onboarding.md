# Strict sandcastle conventions with per-project onboarding

An earlier design centralized what sandcastle distributes: a shared default sandbox image for all projects, a central `CLAUDE_CODE_OAUTH_TOKEN` injected by the harness, and a containerized harness spawning sibling sandboxes through a mounted Docker socket with path-parity mounts. This is reversed. The harness runs as a plain host process and follows sandcastle's own conventions strictly: a Project is a repo that has been Onboarded via the real `sandcastle init` — its own committed `.sandcastle/` directory, its own `sandcastle:<dir-name>` image built with the documented `sandcastle docker build-image` command, its own `.sandcastle/.env` holding credentials that sandcastle's env resolver reads natively. There is no shared image and no central credential injection; the harness adds orchestration (queueing, concurrency, dispatch) on top, never a parallel configuration model.

The deciding trade-off: central config was fewer moving parts to rotate, but it made projects depend on the harness to be runnable and put this repo in the business of re-implementing conventions sandcastle already owns (image naming, env resolution, UID alignment). Strict conventions keep every Project standalone-runnable exactly as the sandcastle docs describe (`npx tsx .sandcastle/main.ts`), and upstream improvements to init/build-image are inherited for free. Token rotation across projects is handled by a sync helper, not by centralizing the token at runtime.

## Consequences

- Dispatching to a repo that was never Onboarded is an error with instructions, not a fallback to a default image.
- The harness may run `sandcastle docker build-image` when a project's image is missing (unattended queued Runs shouldn't die on a fresh clone), but never rebuilds an existing image — Dockerfile edits are followed by a manual, documented rebuild.
- The `init-project` helper is the only sanctioned deviation surface: it wraps `sandcastle init` non-interactively and appends this stack's extras (skills, gh) to the scaffolded Dockerfile, rather than maintaining a separate image lineage.
