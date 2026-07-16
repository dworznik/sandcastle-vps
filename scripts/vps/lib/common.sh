# shellcheck shell=bash
#
# Shared plumbing for the Onboarding commands.

# The workspace root the harness resolves Projects against. Explicit
# WORKSPACE_ROOT wins; otherwise take the deploy's own answer so these
# commands and the harness can never disagree about where Projects live.
workspace_root() {
  if [ -n "${WORKSPACE_ROOT:-}" ]; then
    echo "$WORKSPACE_ROOT"
    return
  fi
  local env_file="$HOME/.sandcastle-vps/.env" root=""
  if [ -f "$env_file" ]; then
    root="$(grep -E '^HOST_WORKSPACE_ROOT=' "$env_file" | head -1 | cut -d= -f2- || true)"
  fi
  if [ -z "$root" ]; then
    echo "Cannot find the workspace root: set WORKSPACE_ROOT, or HOST_WORKSPACE_ROOT in ${env_file}." >&2
    return 1
  fi
  echo "$root"
}

# Reject anything that isn't a plain directory name, so a Project name can
# never reach outside the workspace root. Mirrors resolveProject in src/.
validate_project_name() {
  local name="$1"
  case "$name" in
    "" | . | .. | */* | -*)
      echo "Invalid project name: ${name}" >&2
      return 1
      ;;
  esac
}

# The sandcastle CLI. Prefer the version this repo pins, so Onboarding uses the
# same sandcastle the harness runs with; fall back to npx for a host that has
# no node_modules yet (the deploy does not install them until the harness runs
# as a host process).
sandcastle() {
  local repo_root cli version
  repo_root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)"
  cli="${repo_root}/node_modules/@ai-hero/sandcastle/dist/main.js"
  if [ -f "$cli" ]; then
    node "$cli" "$@"
    return
  fi
  version="$(sed -n 's/.*"@ai-hero\/sandcastle": "[^0-9]*\([0-9][0-9.]*\)".*/\1/p' "${repo_root}/package.json" | head -1)"
  if [ -z "$version" ]; then
    echo "Cannot determine the sandcastle version from ${repo_root}/package.json" >&2
    return 1
  fi
  npx --yes "@ai-hero/sandcastle@${version}" "$@"
}

# The agent token, supplied per invocation and never stored centrally: from the
# environment, or piped in (`claude setup-token | init-project my-app`). The
# only copy that persists is the one in each Project's own .sandcastle/.env.
read_agent_token() {
  local token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
  if [ -z "$token" ] && [ ! -t 0 ]; then
    token="$(cat)"
  fi
  token="$(echo "$token" | tr -d '[:space:]')"
  if [ -z "$token" ]; then
    echo "No agent token. Pass CLAUDE_CODE_OAUTH_TOKEN=... or pipe one in:" >&2
    echo "  claude setup-token | $(basename "$0") ..." >&2
    return 1
  fi
  echo "$token"
}
