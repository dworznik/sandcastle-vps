#!/usr/bin/env bash
#
# Deploy sandcastle-vps to the VPS: rsync the repo to ~/.sandcastle-vps,
# seed/repair the remote .env, build the sandbox + harness images, and
# (re)start the compose stack. The SSH target lives in the gitignored
# deploy.local (see deploy.local.example).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$repo_root/deploy.local" ]; then
  echo "Missing deploy.local — run: cp deploy.local.example deploy.local && edit it" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$repo_root/deploy.local"
: "${SSH_TARGET:?deploy.local must set SSH_TARGET=user@host}"

echo "==> Uploading to $SSH_TARGET:~/.sandcastle-vps"
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude deploy.local \
  --exclude .env \
  "$repo_root/" "$SSH_TARGET:.sandcastle-vps/"

echo "==> Configuring and starting the stack"
ssh "$SSH_TARGET" bash -s <<'REMOTE'
set -euo pipefail
cd "$HOME/.sandcastle-vps"

[ -f .env ] || cp .env.example .env

# Set key=value only when the key is missing or empty — existing values
# (especially secrets) are never overwritten.
ensure_env_key() {
  local key="$1" value="$2"
  local current
  current="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  if [ -n "$current" ]; then
    return 0
  fi
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

ensure_env_key DEV_UID "$(id -u)"
ensure_env_key DEV_GID "$(id -g)"
ensure_env_key DOCKER_GID "$(stat -c %g /var/run/docker.sock)"
ensure_env_key INNGEST_EVENT_KEY "$(openssl rand -hex 32)"
ensure_env_key INNGEST_SIGNING_KEY "$(openssl rand -hex 32)"

# Share the workspace root with the claude-tmux stack when it's configured.
if [ -f "$HOME/.claude-tmux/.env" ]; then
  claude_tmux_root="$(grep -E '^HOST_WORKSPACE_ROOT=' "$HOME/.claude-tmux/.env" | head -1 | cut -d= -f2- || true)"
  [ -n "$claude_tmux_root" ] && ensure_env_key HOST_WORKSPACE_ROOT "$claude_tmux_root"
fi

missing=""
for key in HOST_WORKSPACE_ROOT CLAUDE_CODE_OAUTH_TOKEN; do
  value="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  [ -z "$value" ] && missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "Fill in$missing in ~/.sandcastle-vps/.env, then re-run the deploy." >&2
  echo "(CLAUDE_CODE_OAUTH_TOKEN comes from running: claude setup-token)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "==> Building default sandbox image (${SANDBOX_IMAGE:-sandcastle-vps-sandbox})"
docker build \
  -f docker/sandbox/Dockerfile \
  -t "${SANDBOX_IMAGE:-sandcastle-vps-sandbox}" \
  --build-arg AGENT_UID="$DEV_UID" \
  --build-arg AGENT_GID="$DEV_GID" \
  .

echo "==> Building and starting the compose stack"
docker compose build
docker compose up -d --remove-orphans

echo "==> Installing host dispatch command"
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.sandcastle-vps/scripts/vps/sandcastle-run" "$HOME/.local/bin/sandcastle-run"

echo "==> Done. Dispatch with: sandcastle-run <project> \"task\""
REMOTE
