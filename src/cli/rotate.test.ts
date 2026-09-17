import { describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import type { CredentialSession } from './credentials.js'
import type { LocalShell } from './local.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { isCredential, rotateChoices, rotateCredentials, type Rotatable } from './rotate.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const OLD_TOKEN = 'sk-ant-oat01-oldoldoldoldoldoldoldold'
const NEW_TOKEN = 'sk-ant-oat01-newnewnewnewnewnewnewnew'
const GH_TOKEN = 'github_pat_11AAAAAAA0notarealtokenatall000000000'
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH000 agent@example.com'

const FULL_ENV = [
  'WORKSPACE_ROOT=/home/op/work',
  'SECRETS_DIR=/home/op/.sandcastle-vps/secrets',
  `CLAUDE_CODE_OAUTH_TOKEN=${OLD_TOKEN}`,
  `GH_TOKEN=${GH_TOKEN}`,
  'AGENT_GIT_NAME=Patryk',
  'AGENT_GIT_EMAIL=op@example.com',
  '',
].join('\n')

describe('rotateChoices', () => {
  it('offers the four credentials and the signing key', () => {
    const labels = rotateChoices(FULL_ENV).map((choice) => choice.label)
    expect(labels).toHaveLength(5)
    expect(labels.join('\n')).toContain('Claude token')
    expect(labels.join('\n')).toContain('Signing key')
  })

  // Rotation is also how a Target that was never finished gets finished, so
  // the list says which ones were never captured rather than hiding them.
  it('marks the ones the Target never had', () => {
    const labels = rotateChoices(FULL_ENV.replace(`GH_TOKEN=${GH_TOKEN}`, 'GH_TOKEN=')).map(
      (choice) => choice.label,
    )
    expect(labels.find((label) => label.startsWith('GitHub token'))).toContain('not captured yet')
    expect(labels.find((label) => label.startsWith('Claude token'))).not.toContain('not captured')
  })
})

describe('isCredential', () => {
  // The signing key is rotatable alongside the four, but it is not one of
  // them: it lives in a file, and replacing it is regenerating it rather than
  // asking for a value.
  it('separates the signing key from the environment credentials', () => {
    expect(isCredential('agentToken')).toBe(true)
    expect(isCredential('signingKey')).toBe(false)
  })
})

// ------------------------------------------------------------------- the flow

interface Ran {
  readonly script: string
  readonly stdin: string
}

const fakeConnector = () => {
  const ran: Ran[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      ran.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : '' })
      const ok = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (script.includes('/.env')) return ok(FULL_ENV)
      if (script.includes('ssh-keygen')) return ok(`state\tcreated\npublic\t${PUBLIC_KEY}`)
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, ran }
}

const fakePrompter = (picked: Rotatable[], { go = true }: { go?: boolean } = {}) => {
  const asked: string[] = []
  const prompter: Prompter = {
    text: (question, fallback) => {
      asked.push(question)
      return Promise.resolve(fallback ?? 'typed')
    },
    secret: (question) => {
      asked.push(question)
      return Promise.resolve(question === 'Claude token' ? NEW_TOKEN : GH_TOKEN)
    },
    select: <T>(_q: string, choices: readonly Choice<T>[]) =>
      Promise.resolve(choices[0]?.value as T),
    multi: <T>(question: string, choices: readonly Choice<T>[]) => {
      asked.push(question)
      return Promise.resolve(
        choices.filter((choice) => picked.includes(choice.value as Rotatable)).map((c) => c.value),
      )
    },
    confirm: (question, fallback = false) => {
      asked.push(question)
      return Promise.resolve(question.includes('Go ahead') ? go : fallback)
    },
    close: () => {},
  }
  return { prompter, asked }
}

const local: LocalShell = {
  has: () => Promise.resolve(false),
  run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  interactive: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  open: () => Promise.resolve(),
}

const acceptsToken: typeof globalThis.fetch = () =>
  Promise.resolve(new Response(JSON.stringify({ login: 'dworznik' }), { status: 200 }))

const run = async (picked: Rotatable[], options: { go?: boolean } = {}) => {
  const { connector, ran } = fakeConnector()
  const { prompter, asked } = fakePrompter(picked, options)
  const session: CredentialSession = {
    profile,
    connector,
    prompter,
    local,
    fetchImpl: acceptsToken,
  }
  const lines: string[] = []
  const result = await rotateCredentials(session, (line) => lines.push(line), {
    verifyOptions: { attempts: 1, sleep: () => Promise.resolve() },
  })
  return { result, ran, asked, shown: lines.join('\n') }
}

/** The environment file as it was written back, which is the only place a
 *  rotated value can land. */
const written = (ran: Ran[]): string =>
  ran.find((step) => step.script.includes('mktemp'))?.stdin ?? ''

describe('rotateCredentials', () => {
  it('replaces only what was chosen, and leaves the rest as they were', async () => {
    const { ran, result } = await run(['agentToken'])
    const content = written(ran)
    expect(content).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${NEW_TOKEN}`)
    expect(content).not.toContain(OLD_TOKEN)
    // Untouched, and still there — a rotation that blanked the others would be
    // a rotation that logged the Harness out of everything else.
    expect(content).toContain(`GH_TOKEN=${GH_TOKEN}`)
    expect(content).toContain('AGENT_GIT_NAME=Patryk')
    expect(result?.complete).toBe(true)
  })

  // The difference between rotation and capture is exactly this: capture seeds
  // what is empty and would leave an existing value alone.
  it('overwrites a value that is already there, which capture would not', async () => {
    const { ran } = await run(['agentToken'])
    expect(written(ran)).not.toContain(OLD_TOKEN)
  })

  it('restarts the Harness so it holds the new values', async () => {
    const { ran } = await run(['agentToken'])
    expect(ran.some((step) => step.script.includes('docker compose up -d'))).toBe(true)
  })

  it('regenerates the signing key and waits for the new one to be registered', async () => {
    const { ran, shown, asked } = await run(['signingKey'])
    const keygen = ran.find((step) => step.script.includes('ssh-keygen'))
    // The replacing shape of the script: no "keep what is there" branch.
    expect(keygen?.script).not.toContain('state=kept')
    expect(shown).toContain(PUBLIC_KEY)
    expect(shown).toContain('previous key is replaced')
    expect(asked).toContain('  Registered it?')
  })

  // Nothing was asked for, so nothing should have been asked about — least of
  // all a token the operator did not choose to replace.
  it('changes nothing when nothing is chosen', async () => {
    const { ran, result, shown } = await run([])
    expect(result).toBeUndefined()
    expect(shown).toContain('Nothing chosen')
    expect(ran.every((step) => !step.script.includes('up -d'))).toBe(true)
    expect(written(ran)).toBe('')
  })

  // The old values do not come back, and the signing key in particular is gone
  // from the Target the moment the new one lands.
  it('names what will be replaced and takes no for an answer', async () => {
    const { ran, result, shown } = await run(['agentToken', 'signingKey'], { go: false })
    expect(result).toBeUndefined()
    expect(shown).toContain('Claude token will be asked for again')
    expect(shown).toContain('the old one will be gone')
    expect(written(ran)).toBe('')
    expect(ran.every((step) => !step.script.includes('ssh-keygen'))).toBe(true)
  })
})
