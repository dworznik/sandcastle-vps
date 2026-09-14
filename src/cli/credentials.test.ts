import { describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import {
  CREDENTIAL_ENV,
  captureCredentials,
  findAgentToken,
  missing,
  type CredentialSession,
} from './credentials.js'
import { CREDENTIAL_KEYS } from '../env.js'
import type { LocalShell } from './local.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const AGENT_TOKEN = 'sk-ant-oat01-AbCdEf0123456789_abcdefghijklmnop-qrstuv'
const GH_TOKEN = 'github_pat_11AAAAAAA0notarealtokenatall000000000'
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH000 agent@example.com'

/** What a Target with nothing captured yet answers with — the shape the
 *  install scaffolds, where every credential key is present and empty. */
const BLANK_ENV = [
  'WORKSPACE_ROOT=/home/op/work',
  'SECRETS_DIR=/home/op/.sandcastle-vps/secrets',
  'CLAUDE_CODE_OAUTH_TOKEN=',
  'GH_TOKEN=',
  'AGENT_GIT_NAME=',
  'AGENT_GIT_EMAIL=',
  '',
].join('\n')

const FULL_ENV = BLANK_ENV.replace(
  'CLAUDE_CODE_OAUTH_TOKEN=',
  `CLAUDE_CODE_OAUTH_TOKEN=${AGENT_TOKEN}`,
)
  .replace('GH_TOKEN=', `GH_TOKEN=${GH_TOKEN}`)
  .replace('AGENT_GIT_NAME=', 'AGENT_GIT_NAME=Patryk')
  .replace('AGENT_GIT_EMAIL=', 'AGENT_GIT_EMAIL=op@example.com')

interface Ran {
  readonly script: string
  readonly stdin: string
}

const acceptsToken: typeof globalThis.fetch = () =>
  Promise.resolve(new Response(JSON.stringify({ login: 'dworznik' }), { status: 200 }))

/** The default, so a test that forgot to say what GitHub thinks cannot end up
 *  asking the real one. */
const rejectsToken: typeof globalThis.fetch = () =>
  Promise.resolve(new Response('', { status: 401 }))

/** A Target that answers the scripts this flow sends it, and remembers every
 *  one — which is how the "no secret in a command" claim is checked. */
const fakeConnector = (envContent: string) => {
  const ran: Ran[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      ran.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : '' })
      const answer = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (script.includes('/.env')) return answer(envContent)
      if (script.includes('ssh-keygen')) return answer(`state\tcreated\npublic\t${PUBLIC_KEY}`)
      return answer('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, ran }
}

interface Scripted {
  readonly text?: string[]
  readonly secret?: string[]
  readonly confirm?: boolean[]
}

const fakePrompter = (scripted: Scripted = {}) => {
  const asked: string[] = []
  const text = [...(scripted.text ?? [])]
  const secret = [...(scripted.secret ?? [])]
  const confirm = [...(scripted.confirm ?? [])]
  const prompter: Prompter = {
    text: (question, fallback) => {
      asked.push(question)
      return Promise.resolve(text.shift() ?? fallback ?? '')
    },
    secret: (question) => {
      asked.push(question)
      const next = secret.shift()
      if (next === undefined) throw new Error(`Nothing scripted for secret: ${question}`)
      return Promise.resolve(next)
    },
    select: <T>(_q: string, choices: readonly Choice<T>[]) =>
      Promise.resolve(choices[0]?.value as T),
    confirm: (question, fallback = false) => {
      asked.push(question)
      return Promise.resolve(confirm.shift() ?? fallback)
    },
    close: () => {},
  }
  return { prompter, asked }
}

interface LocalOptions {
  readonly present?: readonly string[]
  readonly setupTokenPrints?: string
  readonly signingKeys?: string
}

const fakeLocal = ({
  present = ['git'],
  setupTokenPrints = '',
  signingKeys = JSON.stringify([{ id: 1, key: PUBLIC_KEY }]),
}: LocalOptions = {}) => {
  const invoked: { command: string; args: readonly string[] }[] = []
  const opened: string[] = []
  const ok = (stdout: string): Promise<ExecResult> =>
    Promise.resolve({ code: 0, stdout, stderr: '' })
  const local: LocalShell = {
    has: (command) => Promise.resolve(present.includes(command)),
    run: (command, args) => {
      invoked.push({ command, args })
      if (command === 'git' && args[2] === 'user.name') return ok('Patryk\n')
      if (command === 'git' && args[2] === 'user.email') return ok('op@example.com\n')
      if (command === 'gh') return ok(signingKeys)
      return ok('')
    },
    interactive: (command, args) => {
      invoked.push({ command, args })
      return ok(setupTokenPrints)
    },
    open: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
  }
  return { local, invoked, opened }
}

/** The whole flow, wired to fakes, with the post-restart check told not to
 *  spend the test's timeout in its retry loop. */
const run = async (
  options: {
    env?: string
    scripted?: Scripted
    local?: LocalOptions
    fetchImpl?: typeof globalThis.fetch
  } = {},
) => {
  const env = options.env ?? BLANK_ENV
  const { connector, ran } = fakeConnector(env)
  const { prompter, asked } = fakePrompter(options.scripted)
  const { local, invoked, opened } = fakeLocal(options.local)
  const session: CredentialSession = {
    profile,
    connector,
    prompter,
    local,
    // Never the real one: a test that reached GitHub would be a test that
    // fails on a plane, and one that leaks a fixture token off the machine.
    fetchImpl: options.fetchImpl ?? rejectsToken,
  }
  const lines: string[] = []
  // The failure is returned rather than thrown so a test can still read what
  // was asked before the flow gave up — a scripted prompter running out of
  // answers is how "it asked one question too many" shows up, and throwing
  // would take the evidence with it.
  let complete: boolean | undefined
  let failure: unknown
  try {
    complete = await captureCredentials(session, (line) => lines.push(line), {
      verifyOptions: { attempts: 1, sleep: () => Promise.resolve() },
    })
  } catch (error) {
    failure = error
  }
  return { complete, failure, ran, asked, invoked, opened, shown: lines.join('\n') }
}

/** Everything the flow said or sent anywhere, except the one place a secret
 *  belongs: the environment file's content, on stdin. */
const everywhereButStdin = (result: Awaited<ReturnType<typeof run>>): string =>
  [
    result.shown,
    ...result.ran.map((r) => r.script),
    ...result.invoked.map((r) => `${r.command} ${r.args.join(' ')}`),
    ...result.opened,
  ].join('\n')

const ANSWERS: Scripted = {
  secret: [AGENT_TOKEN, GH_TOKEN],
  text: ['Patryk', 'op@example.com'],
  confirm: [true],
}

describe('missing', () => {
  // `KEY=` is what the install scaffolds, and the Harness reads it as unset.
  // Reading it as a captured empty string is how a Target would be declared
  // credentialled while every Run ran unauthenticated.
  it('reads an empty key as not captured', () => {
    expect(missing(BLANK_ENV)).toEqual(['agentToken', 'githubToken', 'gitName', 'gitEmail'])
  })

  it('finds nothing to do on a Target that holds them all', () => {
    expect(missing(FULL_ENV)).toEqual([])
  })

  it('asks only for the one that is gone', () => {
    expect(missing(FULL_ENV.replace(`GH_TOKEN=${GH_TOKEN}`, 'GH_TOKEN='))).toEqual(['githubToken'])
  })
})

describe('CREDENTIAL_ENV', () => {
  // Restated rather than imported, because src/env.ts exits the process at
  // import when the Harness environment is incomplete. This is what keeps the
  // restatement honest.
  it('names the same keys the Harness reads', () => {
    expect(Object.values(CREDENTIAL_ENV).sort()).toEqual(
      Object.values(CREDENTIAL_KEYS)
        // The signing key is a path compose derives, not a captured value.
        .filter((key) => key !== CREDENTIAL_KEYS.signingKeyPath)
        .sort(),
    )
  })
})

describe('findAgentToken', () => {
  it('takes a token supplied on its own', () => {
    expect(findAgentToken(AGENT_TOKEN)).toBe(AGENT_TOKEN)
  })

  // `claude setup-token` prints explanatory text around the token. Taking the
  // whole stream concatenated the banner onto it, and the first sign of that
  // was an authentication failure inside a Run.
  it('finds the token in the noise the CLI prints around it', () => {
    const noisy = [
      'Create a long-lived authentication token for Claude Code.',
      '',
      `  ${AGENT_TOKEN}`,
      '',
      'Store this securely — it will not be shown again.',
    ].join('\n')
    expect(findAgentToken(noisy)).toBe(AGENT_TOKEN)
  })

  it('prefers the real token to instructions that merely mention one', () => {
    expect(
      findAgentToken(`Paste your sk-ant-oat01-EXAMPLE0000000000000000 here\n${AGENT_TOKEN}\n`),
    ).toBe(AGENT_TOKEN)
  })

  it('finds nothing in a stream with no token in it', () => {
    expect(findAgentToken('nothing here')).toBeUndefined()
  })
})

describe('captureCredentials', () => {
  it('captures what is missing and reports the Target complete', async () => {
    const result = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    expect(result.complete).toBe(true)
  })

  // The acceptance criterion this exists for. A secret may appear in exactly
  // one place — the environment file's content, which travels on stdin.
  it('puts no secret in a command, on either machine', async () => {
    const result = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    // Without this the test would pass on a flow that threw before it ever
    // held a secret to leak.
    expect(result.failure).toBeUndefined()
    const elsewhere = everywhereButStdin(result)
    expect(elsewhere).not.toContain(AGENT_TOKEN)
    expect(elsewhere).not.toContain(GH_TOKEN)
  })

  it('sends the credentials to the Target as the environment file, over stdin', async () => {
    const { ran } = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    const write = ran.find((r) => r.stdin.includes(AGENT_TOKEN))
    expect(write?.script).toContain('chmod 600')
    expect(write?.stdin).toContain(`${CREDENTIAL_ENV.githubToken}=${GH_TOKEN}`)
    expect(write?.stdin).toContain('AGENT_GIT_EMAIL=op@example.com')
    // The value it was seeded with, untouched: capture is not an install.
    expect(write?.stdin).toContain('WORKSPACE_ROOT=/home/op/work')
  })

  it('restarts the Harness so it holds them', async () => {
    const { ran } = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    expect(ran.some((r) => r.script.includes('docker compose up -d'))).toBe(true)
  })

  it('asks nothing when the Target already holds them all', async () => {
    const { asked, ran } = await run({
      env: FULL_ENV,
      scripted: { confirm: [true] },
      fetchImpl: acceptsToken,
    })
    expect(asked.some((question) => question.includes('token'))).toBe(false)
    // And does not restart a Harness whose environment did not change.
    expect(ran.some((r) => r.script.includes('docker compose up -d'))).toBe(false)
  })

  it('asks only for the credential the Target is short of', async () => {
    const { asked } = await run({
      env: FULL_ENV.replace('AGENT_GIT_NAME=Patryk', 'AGENT_GIT_NAME='),
      scripted: { text: ['Patryk'], confirm: [true] },
    })
    expect(asked).toContain('Author name')
    expect(asked.some((question) => question.includes('Claude token'))).toBe(false)
  })
})

describe('the Claude token', () => {
  it('comes from `claude setup-token` when the dev machine has it', async () => {
    const { invoked, asked } = await run({
      scripted: { secret: [GH_TOKEN], text: ['Patryk', 'op@example.com'], confirm: [true] },
      local: { present: ['git', 'claude'], setupTokenPrints: `banner\n${AGENT_TOKEN}\n` },
      fetchImpl: acceptsToken,
    })
    expect(invoked).toContainEqual({ command: 'claude', args: ['setup-token'] })
    // Asked for the GitHub token, but never for the Claude one.
    expect(asked.some((question) => question.includes('Claude token'))).toBe(false)
  })

  // A `claude` that is on PATH but does not produce a token — cancelled,
  // logged out, or a version that prints something else — must not dead-end.
  it('falls back to a hidden paste when setup-token produces nothing', async () => {
    const { asked } = await run({
      scripted: ANSWERS,
      local: { present: ['git', 'claude'], setupTokenPrints: 'you are not logged in' },
      fetchImpl: acceptsToken,
    })
    expect(asked).toContain('Claude token')
  })

  it('re-asks for a paste with no token in it', async () => {
    const { asked, shown } = await run({
      scripted: { ...ANSWERS, secret: ['my password, oops', AGENT_TOKEN, GH_TOKEN] },
      fetchImpl: acceptsToken,
    })
    expect(asked.filter((question) => question === 'Claude token')).toHaveLength(2)
    expect(shown).toContain('No sk-ant-… token in that')
  })
})

describe('the GitHub token', () => {
  it('opens the page and prints the permissions the token needs', async () => {
    const { opened, shown } = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    expect(opened).toContain('https://github.com/settings/personal-access-tokens/new')
    expect(shown).toContain('Contents')
    expect(shown).toContain('Pull requests')
  })

  // The acceptance criterion: verified against the API *before* being
  // accepted. A token that only fails at `git push`, inside a Run, an hour
  // later, is the failure this replaces.
  it('re-asks for a token GitHub rejected', async () => {
    let calls = 0
    const secondOneWorks: typeof globalThis.fetch = () => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify({ login: 'dworznik' }), { status: 200 }),
      )
    }
    const { asked, shown } = await run({
      scripted: { ...ANSWERS, secret: [AGENT_TOKEN, 'ghp_wrong', GH_TOKEN] },
      fetchImpl: secondOneWorks,
    })
    expect(asked.filter((question) => question === 'GitHub token')).toHaveLength(2)
    expect(shown).toContain('rejected it (401)')
    expect(shown).toContain('authenticates as dworznik')
  })

  // Being unable to install from behind a proxy is not an improvement in
  // safety — but the escape hatch exists only when GitHub was never asked,
  // never when it answered "no".
  it('offers to proceed only when GitHub could not be reached at all', async () => {
    const offline: typeof globalThis.fetch = () => Promise.reject(new Error('ENOTFOUND'))
    const { asked, complete } = await run({
      scripted: { ...ANSWERS, confirm: [true, true] },
      fetchImpl: offline,
    })
    expect(asked).toContain('  Accept it without checking?')
    expect(complete).toBe(true)
  })

  it('never offers that for a token GitHub turned down', async () => {
    // Every token is refused, so the flow asks until the script runs out and
    // the prompter gives up. What matters is what it asked on the way: it
    // re-asked for the token, and never offered to skip the check.
    const { asked, failure } = await run({
      scripted: { ...ANSWERS, secret: [AGENT_TOKEN, 'ghp_wrong', GH_TOKEN] },
      fetchImpl: rejectsToken,
    })
    expect(failure).toBeDefined()
    expect(asked.filter((question) => question === 'GitHub token').length).toBeGreaterThan(1)
    expect(asked).not.toContain('  Accept it without checking?')
  })
})

describe('the signing key', () => {
  it('generates it on the Target, and only sends back the public half', async () => {
    const { ran, shown } = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    const keygen = ran.find((r) => r.script.includes('ssh-keygen'))
    expect(keygen).toBeDefined()
    expect(shown).toContain(PUBLIC_KEY)
    expect(shown).toContain('https://github.com/settings/ssh/new')
  })

  // Confirmed through the API rather than by taking the operator's word for
  // it. The page adds both kinds of key and the type is a dropdown, so "I
  // registered it" and "it can sign" are genuinely different claims.
  it('confirms the registration with gh when it is there', async () => {
    const { invoked, shown, complete } = await run({
      scripted: ANSWERS,
      local: { present: ['git', 'gh'] },
      fetchImpl: acceptsToken,
    })
    expect(invoked).toContainEqual({ command: 'gh', args: ['api', 'user/ssh_signing_keys'] })
    expect(shown).toContain('GitHub lists it as a signing key')
    expect(complete).toBe(true)
  })

  it('says the key is not registered rather than assuming it is', async () => {
    const { shown, complete } = await run({
      scripted: { ...ANSWERS, confirm: [true, false] },
      local: { present: ['git', 'gh'], signingKeys: '[]' },
      fetchImpl: acceptsToken,
    })
    expect(shown).toContain('does not list it among the signing keys')
    // An authentication key registers fine and signs nothing — the likeliest
    // way to reach this branch having done the work.
    expect(shown).toContain('an authentication key does not sign')
    expect(complete).toBe(false)
  })

  it('falls back to asking when gh is not on the dev machine', async () => {
    const { asked, shown } = await run({ scripted: ANSWERS, fetchImpl: acceptsToken })
    expect(shown).toContain('cannot confirm the registration from here')
    expect(asked).toContain('  Registered it?')
  })
})
