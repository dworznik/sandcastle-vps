#!/usr/bin/env bash
#
# Deploy sandcastle-vps to the VPS: upload the repo to ~/.sandcastle-vps,
# seed/repair the remote .env, build and start the compose stack (Orchestrator
# + Harness), and install the host Onboarding commands. The SSH target lives in
# the gitignored deploy.local (see deploy.local.example).
#
# This is the interim path. It is replaced wholesale by the creator CLI, which
# provisions a Target over a Connector with no checkout on either end.
#
# Idempotent: re-running never overwrites an existing .env value.
set -euo pipefail

repo_root="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

if [ ! -f "$repo_root/deploy.local" ]; then
  echo "Missing deploy.local — run: cp deploy.local.example deploy.local && edit it" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$repo_root/deploy.local"
: "${SSH_TARGET:?deploy.local must set SSH_TARGET=user@host}"

# rsync has to exist on the far end before anything else can happen, and its
# own error for a missing remote binary is unhelpful. Ask first.
if ! ssh "$SSH_TARGET" 'command -v rsync > /dev/null'; then
  echo "rsync is not installed on $SSH_TARGET. On Debian: sudo apt-get install -y rsync" >&2
  exit 1
fi

echo "==> Uploading to $SSH_TARGET:~/.sandcastle-vps"
rsync -az --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude deploy.local \
  --exclude .env \
  "$repo_root/" "$SSH_TARGET:.sandcastle-vps/"

echo "==> Configuring the VPS"
ssh "$SSH_TARGET" bash -s <<'REMOTE'
set -euo pipefail
repo="$HOME/.sandcastle-vps"
cd "$repo"

# ------------------------------------------------------------- prerequisites

# Everything this deploy installs is user-local: Node, pnpm, this repo. The
# system packages it leans on are the operator's to provide, so check for all
# of them here, before anything is touched, and name what is missing. `ss`
# matters most: the exposure guard at the end reads it, and without it that
# check would pass on silence.
missing=()
for cmd in docker jq curl openssl ss git; do
  command -v "$cmd" > /dev/null 2>&1 || missing+=("$cmd")
done
docker compose version > /dev/null 2>&1 || missing+=("docker-compose-plugin")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing on this host: ${missing[*]}" >&2
  echo "On Debian: sudo apt-get install -y docker-ce docker-compose-plugin jq curl openssl iproute2 git" >&2
  echo "Docker Engine itself: https://docs.docker.com/engine/install/debian/" >&2
  exit 1
fi
if ! docker info > /dev/null 2>&1; then
  echo "Docker is installed but $USER cannot use it. Join the docker group and log in again:" >&2
  echo "  sudo usermod -aG docker $USER" >&2
  exit 1
fi

# ---------------------------------------------------------------- environment

[ -f .env ] || (umask 077 && cp .env.example .env)
chmod 600 .env

# The repo is already uploaded, so reuse the same upsert the Onboarding
# commands use rather than keeping a second, untested copy of this logic here.
# Its `seed` mode is exactly the guarantee this deploy needs: fill a key in
# only when it has no value, so re-running never overwrites a secret.
# shellcheck disable=SC1091
source scripts/vps/lib/env-file.sh

ensure_env_key() { env_file_upsert .env "$1" "$2" seed; }

env_value() {
  grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true
}

ensure_env_key INNGEST_EVENT_KEY "$(openssl rand -hex 32)"
ensure_env_key INNGEST_SIGNING_KEY "$(openssl rand -hex 32)"

# Earlier versions kept the workspace root under the compose-era name; carry it
# over so an existing deploy doesn't have to be re-answered by hand.
legacy_root="$(env_value HOST_WORKSPACE_ROOT)"
[ -n "$legacy_root" ] && ensure_env_key WORKSPACE_ROOT "$legacy_root"

# Share the workspace root with the claude-tmux stack when it's configured.
if [ -f "$HOME/.claude-tmux/.env" ]; then
  claude_tmux_root="$(grep -E '^HOST_WORKSPACE_ROOT=' "$HOME/.claude-tmux/.env" | head -1 | cut -d= -f2- || true)"
  [ -n "$claude_tmux_root" ] && ensure_env_key WORKSPACE_ROOT "$claude_tmux_root"
fi

if [ -z "$(env_value WORKSPACE_ROOT)" ]; then
  echo "Fill in WORKSPACE_ROOT in ~/.sandcastle-vps/.env, then re-run the deploy." >&2
  exit 1
fi

# Who the Harness runs as, and which group makes the mounted socket usable.
# Both are read off this host rather than guessed, so worktrees written through
# the path-parity mount land owned by the operator and not by root. Seeded, not
# overwritten: a hand-set value survives.
ensure_env_key OPERATOR_UID "$(id -u)"
ensure_env_key OPERATOR_GID "$(id -g)"
docker_gid="$(getent group docker | cut -d: -f3 || true)"
if [ -z "$docker_gid" ] && [ -z "$(env_value DOCKER_GID)" ]; then
  echo "No docker group on this host. Install Docker Engine first." >&2
  exit 1
fi
[ -n "$docker_gid" ] && ensure_env_key DOCKER_GID "$docker_gid"

# ----------------------------------------------------------------- toolchain
#
# The Harness brings its own Node in its image. What still needs one here are
# the host Onboarding commands, which shell out to the sandcastle CLI — until
# Onboarding moves into the Harness container too.

node_major() {
  command -v node > /dev/null 2>&1 || return 1
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || return 1
}

if ! [ "$(node_major || echo 0)" -ge 22 ] 2>/dev/null; then
  echo "==> Installing Node 22 (nvm, user-local — no root)"
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] ||
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
fi
# shellcheck disable=SC1091
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

node_bin="$(command -v node)"
echo "==> Node $("$node_bin" -v) at ${node_bin}"

echo "==> Installing dependencies"
corepack enable pnpm 2> /dev/null || npm install -g pnpm
# --prod, and only so the Onboarding commands can run the sandcastle version
# this repo pins rather than whatever npx resolves to.
pnpm install --frozen-lockfile --prod

# --------------------------------------------------------- retire the old shape

# A Target deployed before the Harness was containerised still has a user
# service holding the Harness port, and the container about to publish it would
# lose that race with an unhelpful "port is already allocated". Stop it here
# rather than making the operator discover the collision. A no-op on a Target
# that never had one.
unit="$HOME/.config/systemd/user/sandcastle-harness.service"
if [ -f "$unit" ]; then
  echo "==> Retiring the host-process Harness service"
  # systemctl --user over ssh has no session bus unless we point at one.
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user disable --now sandcastle-harness > /dev/null 2>&1 || true
  rm -f "$unit"
  systemctl --user daemon-reload > /dev/null 2>&1 || true
fi

# ----------------------------------------------------------------- the stack

echo "==> Building and starting the stack"
# --build: the Harness image is built from this checkout, so a re-deploy that
# changed src/ has to rebuild before it can take effect.
docker compose up -d --build --remove-orphans

echo "==> Waiting for the Harness"
# Resolved to a concrete default here because the exposure guard below
# interpolates it into an alternation: PORT is commented out in .env.example,
# and an empty branch makes that an invalid regex, which would fail the check
# open.
harness_port="$(env_value PORT)"
harness_port="${harness_port:-3000}"
ready=""
for _ in $(seq 1 60); do
  # /health, not /api/inngest: the Inngest routes answer 401 to a request they
  # cannot verify, and an unsigned curl never can.
  if curl -fsS -o /dev/null "http://127.0.0.1:${harness_port}/health"; then
    ready=yes
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "The Harness did not come up. Recent log:" >&2
  docker compose logs --tail 40 harness >&2
  exit 1
fi

echo "==> Installing host commands"
# Dispatch and Onboarding still run on the host; the Harness itself no longer
# does.
mkdir -p "$HOME/.local/bin"
for cmd in sandcastle-run init-project sync-env; do
  ln -sf "${repo}/scripts/vps/${cmd}" "$HOME/.local/bin/${cmd}"
done
# The Onboarding commands run sandcastle with `node`, and nvm only puts node on
# PATH for *interactive* shells: Debian's ~/.bashrc returns early otherwise, so
# `ssh host 'bash -lc init-project …'` found the command but not node.
# ~/.local/bin is on PATH for every login shell via ~/.profile — the mechanism
# the commands above already rely on — so link the resolved node there too.
ln -sf "$node_bin" "$HOME/.local/bin/node"

# --------------------------------------------------------------------- check

# The Dispatch surface and the dashboard are both keyless, so reachability is
# the whole of their access control — assert it rather than trust it. What must
# hold on the host:
#   - the Harness port (resolved to a concrete default above — an empty branch
#     in the alternation below would fail this check open) and 8288: loopback
#     only, which is where compose publishes them;
#   - 8289, 50052, 50053: absent. Inngest binds its connect gateway and gRPC
#     ports on every interface and ignores --host for them; bridge networking
#     is what keeps them inside the container, so their appearing here at all
#     means a container ended up on host networking.
exposed="$(
  ss -ltnH 2>/dev/null |
    awk '{print $4}' |
    grep -E ":(8288|8289|50052|50053|${harness_port})$" |
    grep -vE '^(127\.0\.0\.1|\[::1\]|localhost):' || true
)"
if [ -n "$exposed" ]; then
  echo "REFUSING TO FINISH: these are listening off-loopback:" >&2
  echo "$exposed" >&2
  echo "Nothing here authenticates. Close them before using this deploy." >&2
  exit 1
fi

echo "==> Done."
docker compose ps
echo
echo "    Onboard:  claude setup-token | init-project <project>"
echo "    Dispatch: sandcastle-run <project> \"task\""
echo "    Dashboard: ssh -L 8288:127.0.0.1:8288 <this-host>, then open http://127.0.0.1:8288"
REMOTE
