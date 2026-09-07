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

A header is capped at 100 characters, and for a PR title that cap includes the ` (#N)` GitHub appends on squash — so keep titles to about 90. `900a065` on `main` is 102 characters for exactly this reason.

Anyone enabling Dependabot must set `commit-message.prefix: chore` in `.github/dependabot.yml`; its default `build(deps):` prefix is not one of the seven types and CI will reject it.

Always open a pull request at the end of an implementation (`gh pr create --base main`), rather than leaving the work sitting on a local branch. The PR body states what changed, any decision worth a second opinion, and — explicitly — anything an acceptance criterion asked for that you could not verify.

## Checks

`pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm lint:shell`. The last needs `shellcheck` and `shfmt`, which npm cannot install — `.github/workflows/ci.yml` pins the versions and checksums CI uses. CI runs all of them, plus `pnpm lint:type-aware` and a gitleaks scan of the pushed commits.

A plain `pnpm install` activates the hooks in `.githooks/` via `core.hooksPath`: pre-commit scans staged changes with gitleaks (which must be installed, and the hook refuses to run without it) then formats and lints them; commit-msg runs commitlint.

The linter is oxlint rather than ESLint because typescript-eslint refuses to load against this repo's TypeScript. `.oxlintrc.json` records the detail — don't swap ESLint back in.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `dworznik/sandcastle-vps`, via the `gh` CLI. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are used verbatim — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, both already in active use. See `docs/agents/domain.md`.
