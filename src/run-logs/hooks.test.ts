import { describe, expect, it } from 'vitest'
import { INPUT_MAX } from './reducer.js'
import {
  HOOK_COMMAND,
  HOOK_EVENTS,
  INSTALL_HOOKS_COMMAND,
  SANDBOX_HOOKS_FILE,
  hookSettings,
} from './hooks.js'

describe('hookSettings', () => {
  it('registers the same command for each of the seven events', () => {
    const settings = JSON.parse(hookSettings()) as { hooks: Record<string, unknown[]> }
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [
        'PostToolUse',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'SubagentStart',
        'SubagentStop',
      ].sort(),
    )
    expect(HOOK_EVENTS).toHaveLength(7)
    for (const event of HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: 'command', command: HOOK_COMMAND }] },
      ])
    }
  })
})

describe('HOOK_COMMAND', () => {
  it('appends to the hooks file on the run directory mount', () => {
    expect(HOOK_COMMAND).toContain(`>> ${SANDBOX_HOOKS_FILE}`)
    expect(SANDBOX_HOOKS_FILE).toMatch(/^\/[^~]/u)
  })

  // The two payload fields that can be arbitrarily large are cut down in the
  // hook itself, so a line is one line and no file write travels whole.
  it('reduces the payload in the hook rather than copying it', () => {
    expect(HOOK_COMMAND).toContain(
      `tool_input: ((.tool_input // null) | tojson | .[0:${INPUT_MAX}])`,
    )
    expect(HOOK_COMMAND).toContain('response_bytes: ((.tool_response // null) | tojson | length)')
  })

  it("keeps the ids that join a subagent's hook lines to the stream", () => {
    for (const field of ['session_id', 'tool_name', 'tool_use_id', 'agent_id', 'agent_type']) {
      expect(HOOK_COMMAND).toContain(field)
    }
  })

  // The payload's own `source` (`startup` on SessionStart) would collide with
  // the envelope's `source: "hook"` once the line is merged into events.jsonl.
  it('renames the payload field that collides with the envelope', () => {
    expect(HOOK_COMMAND).toContain('start_source: .source')
    expect(HOOK_COMMAND).not.toMatch(/[{, ]source[,}]/u)
  })

  // The hook runs with the agent's environment, token included. Reading
  // nothing from it is what keeps the token out of the hook file.
  it('reads nothing from the environment', () => {
    expect(HOOK_COMMAND).not.toMatch(/\$[A-Z_{]/u)
    expect(HOOK_COMMAND).not.toContain('env.')
  })
})

describe('INSTALL_HOOKS_COMMAND', () => {
  it('writes user-scope settings, not the worktree’s .claude/', () => {
    expect(INSTALL_HOOKS_COMMAND).toContain('~/.claude/settings.json')
    expect(INSTALL_HOOKS_COMMAND).not.toContain('workspace/.claude')
  })

  it('merges into settings that are already there rather than replacing them', () => {
    expect(INSTALL_HOOKS_COMMAND).toContain(`jq -s '.[0] * .[1]'`)
  })

  it('embeds the settings through a quoted heredoc, so nothing in them expands', () => {
    expect(INSTALL_HOOKS_COMMAND).toContain("<<'EOF'")
    expect(INSTALL_HOOKS_COMMAND).toContain(hookSettings())
  })
})
