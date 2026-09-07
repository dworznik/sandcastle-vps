# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commits, branches, and pull requests

Commit messages always follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`.

- **Types**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`. Add `!` before the colon for a breaking change.
- **Scope** is optional; use it when a change is confined to one area (e.g. `deploy`, `harness`, `onboarding`).
- **Subject** is imperative mood, lowercase, no trailing period — "add init-project helper", not "Added init-project helper.".

Branch names are prefixed with the same types: `<type>/<short-kebab-description>` (e.g. `feat/init-project`, `fix/stale-image-check`). The `sandcastle/` prefix is reserved for Task Branches produced by Runs — never use it for development branches.

Never commit to `main`. Branch first — including for docs-only changes, and even when a skill or command says to commit to the current branch; that instruction assumes you are already on a development branch.

These are enforced, not aspirational: a `commit-msg` hook runs commitlint locally, and CI lints the pull request title, which is what a squash merge turns into the commit on `main`. The enum in `commitlint.config.js` is exactly this list — if you change one, change the other.

Anyone enabling Dependabot must set `commit-message.prefix: chore` in `.github/dependabot.yml`; its default `build(deps):` prefix is not one of the seven types and CI will reject it.

Always open a pull request at the end of an implementation (`gh pr create --base main`), rather than leaving the work sitting on a local branch. The PR body states what changed, any decision worth a second opinion, and — explicitly — anything an acceptance criterion asked for that you could not verify.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `dworznik/sandcastle-vps`, via the `gh` CLI. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are used verbatim — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, both already in active use. See `docs/agents/domain.md`.
