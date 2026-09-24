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

## Tooling

### Checks

Locally: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint:shell`.

`.github/workflows/ci.yml` runs six parallel jobs, none of which invoke `pnpm format` — CI never rewrites files:

| Job       | Runs                                              |
| --------- | ------------------------------------------------- |
| `check`   | `pnpm typecheck` and `pnpm test`                  |
| `format`  | `pnpm format:check`                               |
| `lint`    | `pnpm lint:type-aware`, the fuller pass           |
| `shell`   | `pnpm lint:shell`                                 |
| `secrets` | a gitleaks scan of the pushed commits             |
| `commits` | commitlint over the PR title — pull requests only |

### Publishing

`.github/workflows/publish.yml` runs on a pushed `v*` tag. It calls `ci.yml` as a reusable workflow — the same six jobs, not a copy — then `scripts/check-release-tag.sh` refuses a tag whose version is not `package.json`'s or whose commit is not on `main`, and `pnpm publish` runs with `--provenance` and `--skip-manifest-obfuscation`. The latter is load-bearing: pnpm strips `packageManager` from a published manifest by default, and the Harness image build reaches pnpm through corepack, which needs that field.

Authentication is npm trusted publishing (OIDC) with no stored secret. The exception is the first publish of the package, which trusted publishing cannot do because the package does not exist yet: that one uses an `NPM_TOKEN` secret, and the workflow honours it only while it is set. Delete it once the trusted publisher is configured.

### Formatting

Prettier owns TypeScript, JavaScript, JSON, YAML and Markdown; `node_modules` and `pnpm-lock.yaml` are ignored. `.prettierrc.json`: no semicolons, single quotes, width 100, spaces, `trailingComma: "all"`, `proseWrap: "preserve"`.

Two of those deliberately diverge from the sibling `qr-token` repo, which uses tabs and `trailingComma: "none"`. Both of qr-token's are inherited SvelteKit template defaults rather than a considered house style, so this repo takes spaces and `"all"` — smaller diffs — while matching qr-token on single quotes and width 100. Dropping semicolons is this repo's own choice; qr-token keeps them.

Shell scripts are formatted by `shfmt -i 2 -ci -sr`, not Prettier. `d1ca9c1` reformatted the whole repo in one commit, and `.git-blame-ignore-revs` names it so `git blame` skips it — locally too, since `prepare` sets `blame.ignoreRevsFile`.

### Linting

oxlint, configured in `.oxlintrc.json`. Only the `correctness` category is on. `pedantic` and `suspicious` are deliberately off: turning both on surfaces 58 findings at the time of writing — 27 `require-unicode-regexp`, 12 `max-lines-per-function`, 9 `require-await` and a scattering of others, 38 of the 58 in test files. Style preferences, not bugs.

`pnpm lint:type-aware` is a superset that adds the rules needing the type checker — `no-floating-promises` above all, which is the bug class that matters most in a Hono handler dispatching Inngest work. It is CI-only because it is too slow for a hook people would then start bypassing.

**Not ESLint, and not by accident.** `typescript-eslint` does not merely warn on this repo's TypeScript 7 — it hard-throws `typescript-eslint does not support TS 7.0` and refuses to load. ESLint ships only `espree`, so without that parser it would lint the two `.js`/`.mjs` files here and skip every `.ts` file in `src/` and `scripts/`. oxlint brings its own parser and is indifferent to the TypeScript version.

ESLint becomes viable again when `typescript-eslint` supports TypeScript 7, tracked upstream as typescript-eslint#10940 and targeting >= 7.1. Until then the only ESLint-shaped workaround is installing `typescript@6` alongside `7` purely to feed the linter, which type-checks the code against a compiler it is not built with. That is not a trade this repo makes.

The standing cost of oxlint, knowingly accepted: `oxlint-tsgolint` is version-locked to the TypeScript major, so a TypeScript bump needs a matching bump here or the type-aware pass silently goes dark.

### Secret scanning

gitleaks, configured in `.gitleaks.toml`, which extends the default ruleset rather than replacing it. The defaults already catch an AWS key and — through `generic-api-key` — a high-entropy value assigned to a secret-named variable such as `INNGEST_SIGNING_KEY`.

What no scanner ships is a rule for Anthropic tokens, the one credential this platform handles by design: `claude setup-token` output, per-Project `.sandcastle/.env` files. `.gitleaks.toml` adds one. Its `{80,}` length threshold is load-bearing — it fires on real token lengths while staying silent on the deliberately short token-shaped fixtures the test suite needs, which is why no allowlist entry exists.

Those fixtures live in `src/cli/credentials.test.ts`, `src/cli/prompt.test.ts` and `src/cli/rotate.test.ts`. Keep any new one under 80 characters and it stays silent on its own. Do not add a file-level ignore to buy the same silence: these files are the single most likely place a real token would later land, and an ignore is exactly what would let it through.

This list is duplicated in the comment in `.gitleaks.toml` only by reference — that file points here rather than restating it, so there is one place to update when a fixture moves.

### Dependencies

`minimumReleaseAge: 4320` in `pnpm-workspace.yaml` refuses any version published in the last three days, on every path in — a local `pnpm add` as much as a Dependabot bump. It is enforced at install time, not just resolution: `pnpm install --frozen-lockfile` fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` on a lockfile entry inside the window, so a too-fresh commit turns CI red.

`.github/dependabot.yml` sets `cooldown.default-days: 3` to match, so Dependabot never proposes a routine bump that pnpm would then reject. It also sets `commit-message.prefix: chore`, without which its default `build(deps):` fails the `commits` job.

**Dependabot security updates bypass cooldown by design**, so a freshly published security fix does hit the window — the one case where the two settings cannot be kept in step. To take one sooner, add that package to `minimumReleaseAgeExclude`, merge, then remove the entry. `minimumReleaseAgeStrict` does not help here; only the per-package exclude does.

Raising the window means checking it against the current lockfile first — seven days does not pass today.

### Hooks

`.githooks/`, activated by `core.hooksPath`, which the `prepare` script sets on a plain `pnpm install`. **If you cloned before this landed, run `pnpm install` again — nothing turns the hooks on until you do.**

- **pre-commit** — gitleaks over the staged changes, then lint-staged: Prettier formats staged files and restages them, and the fast oxlint pass runs over them. Either failing blocks the commit.
- **commit-msg** — commitlint against the message. Failing blocks the commit.
- **pre-push** — deliberately none. Everything one would run is already a CI job, and a hook that re-runs the suite on every push is the kind people alias away.

The shell checks are deliberately in no hook either: gitleaks already makes one non-npm binary mandatory to commit, and three would make a fresh clone materially harder to contribute to.

### Binaries npm cannot install

- **gitleaks** — required to commit. The pre-commit hook fails with an install hint rather than skipping, because a secret-scanning hook that quietly does nothing is worse than no hook: it is trusted. `brew install gitleaks`, or a release from <https://github.com/gitleaks/gitleaks/releases>.
- **shellcheck** and **shfmt** — needed only for `pnpm lint:shell`, which reproduces the `shell` CI job. `brew install shellcheck shfmt`, or releases from <https://github.com/koalaman/shellcheck/releases> and <https://github.com/mvdan/sh/releases>.

`.github/workflows/ci.yml` pins the version and SHA-256 of all three. Match those to be sure you see what CI sees.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `dworznik/sandcastle-vps`, via the `gh` CLI. External PRs are **not** a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles are used verbatim — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root, both already in active use. See `docs/agents/domain.md`.
