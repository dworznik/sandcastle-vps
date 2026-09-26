import { describe, expect, it } from 'vitest'
import { GIT_SETUP_COMMAND, SANDBOX_SIGNING_KEY_PATH, agentSandbox } from './agent.js'
import type { AgentCredentials } from './env.js'
import { INSTALL_HOOKS_COMMAND, SANDBOX_HOOKS_FILE } from './run-logs/hooks.js'

const complete: AgentCredentials = {
  agentToken: 'sk-ant-oat01-token',
  githubToken: 'github_pat_token',
  gitName: 'Patryk Dwórznik',
  gitEmail: 'patryk@example.com',
  signingKeyPath: '/srv/sandcastle-vps/secrets/agent_signing_key',
}

const keyExists = (path: string) => path === complete.signingKeyPath

/** The Run's hooks file, on the Target. */
const observe = { hooksFile: '/home/op/work/todo/.sandcastle/runs/01K5A/hooks.jsonl' }

describe('agentSandbox', () => {
  it('hands the Sandbox the identity as environment, not as files in the checkout', () => {
    expect(agentSandbox(complete, observe, keyExists).env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token',
      GH_TOKEN: 'github_pat_token',
      AGENT_GIT_NAME: 'Patryk Dwórznik',
      AGENT_GIT_EMAIL: 'patryk@example.com',
    })
  })

  it('mounts the signing key read-only, from the path it has on the Target', () => {
    expect(agentSandbox(complete, observe, keyExists).mounts).toContainEqual({
      hostPath: '/srv/sandcastle-vps/secrets/agent_signing_key',
      sandboxPath: SANDBOX_SIGNING_KEY_PATH,
      readonly: true,
    })
  })

  // The file, not the run directory: the agent gets to append its own
  // account of the Run and nothing else. The Harness's records beside it
  // stay out of the Sandbox's reach.
  it('mounts the hooks file writable, and only that file of the run directory', () => {
    const { mounts } = agentSandbox(complete, observe, keyExists)
    expect(mounts).toContainEqual({
      hostPath: observe.hooksFile,
      sandboxPath: SANDBOX_HOOKS_FILE,
      readonly: false,
    })
    expect(mounts).toHaveLength(2)
  })

  it('configures git and installs the hooks in the Sandbox before the agent starts', () => {
    const { hooks } = agentSandbox(complete, observe, keyExists)
    expect(hooks.sandbox?.onSandboxReady).toEqual([
      { command: GIT_SETUP_COMMAND },
      { command: INSTALL_HOOKS_COMMAND },
    ])
  })

  // sandcastle echoes each hook command into the Run's log, so a token
  // interpolated into one is a token in the log. The hook reads them from the
  // environment instead — which is why this asserts on the command's text.
  it('keeps every secret out of the hook command', () => {
    expect(GIT_SETUP_COMMAND).not.toContain(complete.agentToken)
    expect(GIT_SETUP_COMMAND).not.toContain(complete.githubToken)
    expect(GIT_SETUP_COMMAND).toContain('"$AGENT_GIT_NAME"')
    expect(GIT_SETUP_COMMAND).toContain('"$AGENT_GIT_EMAIL"')
  })

  it('sets up ssh signing against the mounted key, and a gh helper for pushes', () => {
    expect(GIT_SETUP_COMMAND).toContain('gpg.format ssh')
    expect(GIT_SETUP_COMMAND).toContain(`user.signingkey ${SANDBOX_SIGNING_KEY_PATH}`)
    expect(GIT_SETUP_COMMAND).toContain('commit.gpgsign true')
    expect(GIT_SETUP_COMMAND).toContain('gh auth git-credential')
  })

  describe('when the Harness was never given an identity', () => {
    it.each([
      ['agentToken', 'CLAUDE_CODE_OAUTH_TOKEN'],
      ['githubToken', 'GH_TOKEN'],
      ['gitName', 'AGENT_GIT_NAME'],
      ['gitEmail', 'AGENT_GIT_EMAIL'],
      ['signingKeyPath', 'AGENT_SIGNING_KEY'],
    ] as const)('refuses the Run and names %s by the key that sets it', (field, key) => {
      const { [field]: _dropped, ...partial } = complete
      expect(() => agentSandbox(partial, observe, keyExists)).toThrow(key)
    })

    it('names every missing value at once rather than one per attempt', () => {
      expect(() => agentSandbox({}, observe, keyExists)).toThrow(
        /CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, AGENT_GIT_NAME, AGENT_GIT_EMAIL, AGENT_SIGNING_KEY/,
      )
    })

    it('says how to fix it rather than only what is wrong', () => {
      expect(() => agentSandbox({}, observe, keyExists)).toThrow(/npx @dworznik\/sandcastle-vps/)
    })
  })

  // Docker creates a directory for a bind source that does not exist, so
  // without this the Sandbox would start with an empty directory where the key
  // should be and fail deep inside the agent's first commit.
  it('refuses a signing key path with no file at it', () => {
    expect(() => agentSandbox(complete, observe, () => false)).toThrow(
      /\/srv\/sandcastle-vps\/secrets\/agent_signing_key.*no file there/s,
    )
  })
})
