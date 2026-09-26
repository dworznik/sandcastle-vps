/**
 * Claude Code hooks inside the Sandbox: the agent's own account of what it
 * did, written from the inside of the Sandbox wall while the stream reducer
 * watches from the outside.
 *
 * Each hook is a `jq` one-liner that appends one reduced line to the hooks
 * file, which the Run bind-mounts from its run directory. The reduction
 * happens in the hook, not later: a `Write` tool's input is the whole file,
 * and a line that carried it would be as long as the file.
 *
 * Installed at user scope rather than in the worktree's `.claude/`, so nothing
 * about observation lands in the Project or depends on workspace trust.
 */

import { INPUT_MAX } from './reducer.js'

/**
 * Where the Sandbox sees the hooks file. Only the file is mounted, not the
 * run directory: the agent gets to append its own account and nothing else,
 * so the Harness's records in the same directory stay the Harness's.
 *
 * Under the agent's home, beside the signing key's mount, because sandcastle
 * refuses a file mount whose parent directory it cannot create — and it
 * creates parents only under the Sandbox home.
 */
export const SANDBOX_HOOKS_FILE = '/home/agent/.sandcastle-run/hooks.jsonl'

/**
 * The hook command, run with the event's JSON on stdin. It keeps the fields
 * that identify the step and cuts the two that can be arbitrarily large.
 * `tool_response` is reduced to its size: its shape differs per tool.
 *
 * The payload's own `source` field (`startup` on SessionStart) is renamed:
 * once the line is merged into `events.jsonl` it would collide with the
 * envelope's `source: "hook"`. `reason` on SessionEnd is renamed to match.
 *
 * It reads nothing from the environment, deliberately: the hook runs with the
 * agent's environment, token included, and this file is served to a browser.
 */
export const HOOK_COMMAND =
  `jq -c '{t: (now | todate), event: .hook_event_name, session_id, tool_name, tool_use_id, ` +
  `tool_input: ((.tool_input // null) | tojson | .[0:${INPUT_MAX}]), ` +
  `response_bytes: ((.tool_response // null) | tojson | length), ` +
  `start_source: .source, end_reason: .reason, agent_id, agent_type} | ` +
  `with_entries(select(.value != null))' >> ${SANDBOX_HOOKS_FILE}`

/** The lifecycle, the tool calls, and the subagents — the events a run page
 *  nests under an Agent call by their `agent_id`. */
export const HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
]

export const hookSettings = (): string =>
  JSON.stringify({
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      ]),
    ),
  })

/**
 * Runs in the Sandbox as the agent user, after sandcastle's own setup and
 * before the agent starts — the same slot the git identity uses. Merges into
 * a settings file the image may already carry rather than replacing it.
 */
export const INSTALL_HOOKS_COMMAND = `set -eu
mkdir -p ~/.claude
if [ -f ~/.claude/settings.json ]; then
  jq -s '.[0] * .[1]' ~/.claude/settings.json - > ~/.claude/settings.json.new <<'EOF'
${hookSettings()}
EOF
  mv ~/.claude/settings.json.new ~/.claude/settings.json
else
  cat > ~/.claude/settings.json <<'EOF'
${hookSettings()}
EOF
fi`
