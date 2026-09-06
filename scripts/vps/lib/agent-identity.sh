# shellcheck shell=bash
#
# The agent's identity — whose commits they are, how they are signed, how they
# are pushed — is defined once per VPS (~/.sandcastle-vps/agent.env and the
# signing key beside it) and stamped into every Project's own .sandcastle/,
# exactly as the Claude token is. The Harness never reads the central copy
# (ADR 0003): what reaches a sandbox is that Project's .env and key.
#
# Requires lib/env-file.sh to be sourced first.

sandcastle_home() { echo "${SANDCASTLE_HOME:-$HOME/.sandcastle-vps}"; }
agent_env_file() { echo "$(sandcastle_home)/agent.env"; }
agent_signing_key() { echo "$(sandcastle_home)/agent_signing_key"; }

# stamp_agent_identity <sandcastle_dir> <seed|rotate>
#
# Copies whatever identity exists into the Project: the AGENT_GIT_* and
# GH_TOKEN lines into .env, and the signing key as agent_signing_key (mode 600,
# added to .gitignore so it can never ride along when .sandcastle/ is committed).
# Succeeds with a note when nothing is configured yet: a Project may be
# Onboarded before the identity exists, and sync-env fills it in later.
stamp_agent_identity() {
  local dir="$1" mode="${2:-seed}" env_file key stamped=0 k v
  env_file="$(agent_env_file)"
  key="$(agent_signing_key)"

  if [ -f "$env_file" ]; then
    for k in AGENT_GIT_NAME AGENT_GIT_EMAIL GH_TOKEN; do
      v="$(grep -E "^${k}=" "$env_file" | head -1 | cut -d= -f2- || true)"
      [ -n "$v" ] || continue
      env_file_upsert "${dir}/.env" "$k" "$v" "$mode"
      stamped=$((stamped + 1))
    done
  fi

  if [ -f "$key" ]; then
    (umask 077 && cp "$key" "${dir}/agent_signing_key")
    chmod 600 "${dir}/agent_signing_key"
    grep -qxF agent_signing_key "${dir}/.gitignore" 2> /dev/null ||
      echo agent_signing_key >> "${dir}/.gitignore"
    stamped=$((stamped + 1))
  fi

  if [ "$stamped" -eq 0 ]; then
    echo "  (no agent identity configured yet — fill ${env_file} and run sync-env)" >&2
  fi
  return 0
}
