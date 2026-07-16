# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commits and branches

Commit messages always follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`.

- **Types**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Add `!` before the colon for a breaking change.
- **Scope** is optional; use it when a change is confined to one area (e.g. `deploy`, `harness`, `onboarding`).
- **Subject** is imperative mood, lowercase, no trailing period — "add init-project helper", not "Added init-project helper.".

Branch names are prefixed with the same types: `<type>/<short-kebab-description>` (e.g. `feat/init-project`, `fix/stale-image-check`). The `sandcastle/` prefix is reserved for Task Branches produced by Runs — never use it for development branches.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `dworznik/sandcastle-vps`, via the `gh` CLI. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are used verbatim — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, both already in active use. See `docs/agents/domain.md`.
