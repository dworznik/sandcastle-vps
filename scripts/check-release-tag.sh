#!/usr/bin/env bash
# Is this tag a release of the commit it points at? Two things can be wrong,
# and either is a refusal: the tag names a version package.json does not
# carry, or the tagged commit is not on main. Both are checked before anything
# is published, so "why did v0.2.0 not publish" is one line in the job log
# rather than a package on npm that should not be there.
#
# Run by .github/workflows/publish.yml; runnable from a checkout too, which is
# how it is tested.
set -euo pipefail

tag="${1:?usage: check-release-tag.sh <tag> [<commit>]}"
commit="${2:-HEAD}"

version="$(node -p 'require("./package.json").version')"
if [ "$tag" != "v$version" ]; then
  echo "check-release-tag: $tag does not match package.json, which is at $version. Nothing is published." >&2
  exit 1
fi

# origin/main rather than main: a tag checkout in CI has no local main, and a
# stale local main on a dev machine would answer for the wrong commit.
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "check-release-tag: $tag is not on main. Nothing is published." >&2
  exit 1
fi

echo "check-release-tag: $tag matches package.json and is on main."
