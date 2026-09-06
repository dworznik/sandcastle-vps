#!/usr/bin/env bash
#
# Deploy sandcastle-vps to the VPS: upload the repo to ~/.sandcastle-vps,
# install Node and dependencies, seed/repair the remote .env, start the
# Orchestrator (compose) and the Harness (systemd user service), and install
# the host commands. The SSH target lives in the gitignored deploy.local
# (see deploy.local.example).
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

# systemctl --user over ssh has no session bus unless we point at one.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

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

# Seeded explicitly rather than left to the .env.example copy: that copy only
# happens for a *new* .env, so an upgrade from the compose era — where these
# lived in compose.yaml — would otherwise never get them, and the SDK would
# quietly talk to Inngest Cloud instead of the Orchestrator next door.
ensure_env_key INNGEST_BASE_URL "http://127.0.0.1:8288"
ensure_env_key INNGEST_DEV 0

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

# The Orchestrator is a bridged container that has to dial the Harness. A
# container has no route to host loopback, so the Harness also binds the docker
# bridge gateway — an address only this host and its containers can reach —
# and this is where that address is discovered. Seeded, not overwritten: a
# hand-set value survives; clear it in .env to re-detect.
bridge_ip="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
if [ -z "$bridge_ip" ] && [ -z "$(env_value DOCKER_BRIDGE_IP)" ]; then
  echo "Could not read the docker bridge gateway. Is Docker running, and is $USER in the docker group?" >&2
  exit 1
fi
[ -n "$bridge_ip" ] && ensure_env_key DOCKER_BRIDGE_IP "$bridge_ip"

# ----------------------------------------------------------------- toolchain

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
# --prod: the VPS runs the Harness, it doesn't typecheck or test it. tsx is a
# runtime dependency, so the service still has what it needs.
pnpm install --frozen-lockfile --prod

# -------------------------------------------------------------- orchestrator

echo "==> Starting the Orchestrator"
docker compose up -d --remove-orphans

# ------------------------------------------------------------------- harness

echo "==> Installing the Harness service"
# Lingering is what makes the user service survive a reboot with nobody logged
# in. Without it systemd tears the whole user manager down at logout.
loginctl enable-linger "$USER" 2> /dev/null ||
  sudo -n loginctl enable-linger "$USER" 2> /dev/null || {
  echo "WARNING: could not enable lingering. The Harness will not survive a" >&2
  echo "         reboot until you run: sudo loginctl enable-linger $USER" >&2
}

mkdir -p "$HOME/.config/systemd/user"
sed -e "s|@REPO@|${repo}|g" -e "s|@NODE@|${node_bin}|g" \
  systemd/sandcastle-harness.service \
  > "$HOME/.config/systemd/user/sandcastle-harness.service"

systemctl --user daemon-reload
systemctl --user enable sandcastle-harness
systemctl --user restart sandcastle-harness

echo "==> Installing host commands"
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

sleep 2
if ! systemctl --user is-active --quiet sandcastle-harness; then
  echo "The Harness service failed to start. Recent log:" >&2
  journalctl --user -u sandcastle-harness -n 30 --no-pager >&2
  exit 1
fi

# The Dispatch surface and the dashboard are both keyless, so reachability is
# the whole of their access control — assert it rather than trust it. What
# must hold on the host:
#   - the Harness port: loopback, plus the docker bridge gateway (the one
#     address the Orchestrator's container can reach; unroutable from outside);
#   - 8288: loopback only (published there by compose);
#   - 8289, 50052, 50053: absent. Inngest binds its connect gateway and gRPC
#     ports on every interface and ignores --host for them; bridge networking
#     is what keeps them inside the container, so their appearing here at all
#     means the container is on host networking again.
# Resolve the port to a concrete default first: PORT is commented out in
# .env.example, and an empty branch here makes the alternation an invalid
# regex, which would fail this check open.
harness_port="$(env_value PORT)"
harness_port="${harness_port:-3000}"
bridge_ip="$(env_value DOCKER_BRIDGE_IP)"

exposed="$(
  ss -ltnH 2>/dev/null |
    awk '{print $4}' |
    grep -E ":(8288|8289|50052|50053|${harness_port})$" |
    grep -vE '^(127\.0\.0\.1|\[::1\]|localhost):' |
    grep -vxF "${bridge_ip}:${harness_port}" || true
)"
if [ -n "$exposed" ]; then
  echo "REFUSING TO FINISH: these are listening off-loopback:" >&2
  echo "$exposed" >&2
  echo "Nothing here authenticates. Close them before using this deploy." >&2
  exit 1
fi

echo "==> Done."
systemctl --user --no-pager --lines=0 status sandcastle-harness | head -3
echo
echo "    Onboard:  claude setup-token | init-project <project>"
echo "    Dispatch: sandcastle-run <project> \"task\""
echo "    Dashboard: ssh -L 8288:127.0.0.1:8288 <this-host>, then open http://127.0.0.1:8288"
REMOTE
