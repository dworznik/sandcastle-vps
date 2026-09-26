import { describe, expect, it } from 'vitest'
import { parseEnv } from './env.js'

/** The one setting with no sensible default. */
const complete = { WORKSPACE_ROOT: '/home/op/work' }

describe('parseEnv', () => {
  it('needs only the workspace root, and fills in the rest', () => {
    expect(parseEnv(complete)).toEqual({
      workspaceRoot: '/home/op/work',
      defaultModel: 'claude-opus-4-8',
      host: '127.0.0.1',
      port: 3000,
      orchestratorUrl: 'http://127.0.0.1:8288',
      credentials: {
        agentToken: undefined,
        githubToken: undefined,
        gitName: undefined,
        gitEmail: undefined,
        signingKeyPath: undefined,
      },
    })
  })

  // Compose sets 0.0.0.0 explicitly for the container, where exposure is
  // decided by port publishing. Everywhere else — a server run directly in
  // development — the keyless Dispatch surface stays on loopback.
  it('takes the address compose gives the container', () => {
    expect(parseEnv({ ...complete, HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  // The same variable the Inngest SDK reads, so the Harness asks the
  // Orchestrator it sends to and no other. Compose sets it by service name.
  it('finds the Orchestrator where the SDK does, minus any trailing slash', () => {
    expect(
      parseEnv({ ...complete, INNGEST_BASE_URL: 'http://inngest:8288/' }).orchestratorUrl,
    ).toBe('http://inngest:8288')
  })

  it('reads the port as a number, not the string it arrives as', () => {
    expect(parseEnv({ ...complete, PORT: '3399' }).port).toBe(3399)
  })

  // `Number(process.env.PORT)` used to turn each of these into 0 or NaN, and a
  // bind to port 0 is a listener on a port nobody is dispatching to.
  it.each(['', '0', 'abc', '70000', '3000.5'])(
    'refuses PORT=%o rather than binding something else',
    (port) => {
      expect(() => parseEnv({ ...complete, PORT: port })).toThrow(/PORT/)
    },
  )

  it('takes an agent model override, and defends the default from an empty one', () => {
    expect(parseEnv({ ...complete, AGENT_MODEL: 'claude-sonnet-5' }).defaultModel).toBe(
      'claude-sonnet-5',
    )
    expect(() => parseEnv({ ...complete, AGENT_MODEL: '' })).toThrow(/AGENT_MODEL/)
  })

  it('names what is missing rather than failing later', () => {
    expect(() => parseEnv({})).toThrow(/WORKSPACE_ROOT/)
  })

  // The path is mounted into the Harness at the same path it has on the
  // Target; a relative one would resolve against whatever cwd happens to be.
  it('insists the workspace root is absolute', () => {
    expect(() => parseEnv({ WORKSPACE_ROOT: 'work' })).toThrow(/absolute/)
  })

  describe('the agent credentials', () => {
    const identity = {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token',
      GH_TOKEN: 'github_pat_token',
      AGENT_GIT_NAME: 'Patryk Dwórznik',
      AGENT_GIT_EMAIL: 'patryk@example.com',
      AGENT_SIGNING_KEY: '/srv/sandcastle-vps/secrets/agent_signing_key',
    }

    it('reads them off the environment the Harness was given', () => {
      expect(parseEnv({ ...complete, ...identity }).credentials).toEqual({
        agentToken: 'sk-ant-oat01-token',
        githubToken: 'github_pat_token',
        gitName: 'Patryk Dwórznik',
        gitEmail: 'patryk@example.com',
        signingKeyPath: '/srv/sandcastle-vps/secrets/agent_signing_key',
      })
    })

    // The install brings the stack up before any credential is captured. A
    // Harness that refused to start here would leave a restart loop instead of
    // a running stack to add credentials to; the Run says what is missing.
    it('lets the Harness start without any of them', () => {
      expect(parseEnv(complete).credentials).toEqual({
        agentToken: undefined,
        githubToken: undefined,
        gitName: undefined,
        gitEmail: undefined,
        signingKeyPath: undefined,
      })
    })

    // `KEY=` is exactly what the Target's environment file scaffolds, and
    // reading it as "" rather than as absent would run an unauthenticated Run.
    it.each(Object.keys(identity))('reads a scaffolded, empty %s as missing', (key) => {
      const credentials = parseEnv({ ...complete, ...identity, [key]: '' }).credentials
      expect(Object.values(credentials).filter((value) => value === undefined)).toHaveLength(1)
    })

    // It is also a path on the Target, where the Sandbox's bind mount is made.
    it('insists the signing key path is absolute', () => {
      expect(() => parseEnv({ ...complete, AGENT_SIGNING_KEY: 'secrets/key' })).toThrow(
        /AGENT_SIGNING_KEY/,
      )
    })
  })
})
