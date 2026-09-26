#!/bin/bash
# Run the claude-mem worker that a Session installed into the shared
# ~/.claude volume, and nothing else (ADR 0010).
#
# The plugin is found the way Claude Code records it: the install path in
# plugins/installed_plugins.json, falling back to the newest version under the
# plugin cache. Until it is there, this says so and looks again, rather than
# exiting into a restart loop that would hide the message. Once found, the
# worker runs in the foreground with `--daemon`, which for this script is the
# long-lived server process — the flag only changes how it treats SIGHUP.
# A restart requested through its admin route, or a `docker compose restart`,
# comes back through here and picks up whatever version is installed then.
set -eu

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
registry="$claude_dir/plugins/installed_plugins.json"
cache="$claude_dir/plugins/cache/thedotmack/claude-mem"
plugin_id="claude-mem@thedotmack"

log() {
  echo "[memory] $*"
}

# Every place the plugin might be, most authoritative first.
find_roots() {
  if [ -f "$registry" ]; then
    # The first install of the plugin under its id, as Claude Code writes it.
    bun -e '
      const file = process.argv[1]
      const id = process.argv[2]
      const found = JSON.parse(require("fs").readFileSync(file, "utf8"))?.plugins?.[id]?.[0]?.installPath
      if (found) console.log(found)
    ' "$registry" "$plugin_id" 2> /dev/null || true
  fi
  if [ -d "$cache" ]; then
    find "$cache" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1
  fi
}

# The worker itself exits at once when the plugin is disabled in Claude
# Code's settings, which under `restart: unless-stopped` would be a restart
# loop; say so and wait instead, the same way as for a plugin not yet there.
plugin_disabled() {
  [ -f "$claude_dir/settings.json" ] || return 1
  bun -e '
    const file = process.argv[1]
    const id = process.argv[2]
    const off = JSON.parse(require("fs").readFileSync(file, "utf8"))?.enabledPlugins?.[id] === false
    process.exit(off ? 0 : 1)
  ' "$claude_dir/settings.json" "$plugin_id" 2> /dev/null
}

root=""
while :; do
  while IFS= read -r candidate; do
    if [ -n "$candidate" ] && [ -f "$candidate/scripts/worker-service.cjs" ]; then
      root="$candidate"
      break
    fi
  done < <(find_roots)
  if [ -n "$root" ] && plugin_disabled; then
    log "claude-mem is installed but disabled in Claude Code's settings — enable it from a Session."
    log "Checking again in 60s."
    root=""
    sleep 60
    continue
  fi
  [ -n "$root" ] && break
  log "claude-mem is not installed in the shared login volume yet."
  log "Inside any Session, run: claude plugin install $plugin_id — checking again in 60s."
  sleep 60
done

# What the plugin's own install step does when the modules are missing. The
# hook that runs it only runs inside a Session, and the plugin may have been
# installed without a Session starting since.
if [ ! -d "$root/node_modules" ]; then
  log "installing the plugin's dependencies into $root"
  (cd "$root" && bun install --production) || log "dependency install failed; starting anyway"
fi

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$root/package.json" | head -1)"
log "starting claude-mem ${version:-unknown} from $root on ${CLAUDE_MEM_WORKER_HOST:-0.0.0.0}:${CLAUDE_MEM_WORKER_PORT:-37777}"
cd "$root"
exec bun "$root/scripts/worker-service.cjs" --daemon
