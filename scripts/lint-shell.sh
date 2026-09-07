#!/usr/bin/env bash
# Every shell script in the repo, checked the way CI checks it — so a
# contributor can reproduce that job without reading the workflow.
set -euo pipefail

# CI-only tools by design: gitleaks already makes one non-npm binary mandatory
# to commit, and three would make a fresh clone materially harder to
# contribute to. So this fails with a hint rather than assuming they are here.
for tool in shellcheck shfmt; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    cat >&2 << MISSING
lint-shell: $tool is not installed.

  macOS:  brew install $tool
  Linux:  the pinned release and checksum are in .github/workflows/ci.yml

MISSING
    exit 1
  fi
done

# Shebang-based, not glob-based: init-project, sandcastle-run and sync-env
# carry no .sh extension. shfmt also walks node_modules, which is a few hundred
# vendored scripts that are none of this repo's business.
mapfile -t scripts < <(shfmt -f . | grep -v '^node_modules/')

if [ ${#scripts[@]} -eq 0 ]; then
  echo 'lint-shell: found no shell scripts, which cannot be right.' >&2
  exit 1
fi

# -x -P SCRIPTDIR so the `source "${here}/lib/…"` lines in the vps commands
# resolve to the libraries they actually load.
shellcheck -x -P SCRIPTDIR "${scripts[@]}"
shfmt -i 2 -ci -sr -d "${scripts[@]}"
