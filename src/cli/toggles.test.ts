import { describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import { OFF, readToggles, writeToggle, type Toggle } from './posture.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { readEnv } from './target-env.js'
import { TRUST_RULE, toggleFromMenu } from './toggles.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const INSTALLED = [
  'WORKSPACE_ROOT=/home/op/work',
  'SESSIONS_ENABLED=false',
  'ACCESS_ENABLED=false',
  '',
].join('\n')

// ------------------------------------------------------------------- the flow

interface Ran {
  readonly script: string
  readonly stdin: string
}

const fakeConnector = (env: string | undefined = INSTALLED, code = 0) => {
  const ran: Ran[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      ran.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : '' })
      if (code !== 0) {
        return Promise.resolve({ code, stdout: '', stderr: 'ssh: connect to host vps port 22' })
      }
      if (script.includes('/.env') && script.startsWith('cat ')) {
        return Promise.resolve({ code: 0, stdout: env ?? '', stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' })
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, ran }
}

const fakePrompter = (pick: Toggle | null, { confirmed = true }: { confirmed?: boolean } = {}) => {
  const asked: string[] = []
  const prompter: Prompter = {
    text: (question, fallback) => {
      asked.push(question)
      return Promise.resolve(fallback ?? 'typed')
    },
    secret: (question) => {
      asked.push(question)
      return Promise.resolve('never')
    },
    select: <T>(question: string, choices: readonly Choice<T>[]) => {
      asked.push(question)
      const choice = choices.find((candidate) => candidate.value === pick)
      return Promise.resolve((choice ?? choices.at(-1))?.value as T)
    },
    multi: () => Promise.resolve([]),
    confirm: (question) => {
      asked.push(question)
      return Promise.resolve(confirmed)
    },
    close: () => {},
  }
  return { prompter, asked }
}

const run = async (
  pick: Toggle | null,
  { env, code, confirmed }: { env?: string; code?: number; confirmed?: boolean } = {},
) => {
  const { connector, ran } = fakeConnector(env, code)
  const { prompter, asked } = fakePrompter(pick, { confirmed })
  const lines: string[] = []
  const result = await toggleFromMenu({ profile, connector, prompter }, (line) => lines.push(line))
  const written = ran.find((call) => call.stdin !== '')?.stdin
  return { result, ran, asked, written, shown: lines.join('\n') }
}

describe('toggleFromMenu', () => {
  it('shows each toggle with its current state', async () => {
    const { asked, shown } = await run(null)
    expect(asked.join('\n')).toContain('Sessions and access')
    expect(shown).toContain('Run-only Target')
  })

  it('enables sessions after the trust rule is shown and accepted', async () => {
    const { result, written, shown } = await run('sessions')
    expect(shown).toContain(TRUST_RULE)
    expect(written).toBeDefined()
    expect(readToggles(written ?? '')).toEqual({ sessions: true, access: false })
    expect(result).toEqual({ sessions: true, access: false })
  })

  // The trust rule is the whole reason this asks: a Project you open a
  // Session on runs its committed Dockerfile with the Docker socket available.
  it('leaves sessions off when the trust rule is declined, and writes nothing', async () => {
    const { result, written, asked } = await run('sessions', { confirmed: false })
    expect(asked.some((question) => question.includes('Enable sessions'))).toBe(true)
    expect(written).toBeUndefined()
    expect(result).toEqual(OFF)
  })

  it('enables access without the sessions warning, independently of sessions', async () => {
    const { result, written, shown, asked } = await run('access')
    expect(shown).not.toContain(TRUST_RULE)
    expect(asked.some((question) => question.includes('Enable'))).toBe(false)
    expect(readToggles(written ?? '')).toEqual({ sessions: false, access: true })
    expect(result).toEqual({ sessions: false, access: true })
  })

  it('disables a toggle that is on, without asking', async () => {
    const on = writeToggle(INSTALLED, 'sessions', true)
    const { result, asked, written } = await run('sessions', { env: on })
    expect(asked.some((question) => question.includes('Enable'))).toBe(false)
    expect(readToggles(written ?? '')).toEqual(OFF)
    expect(result).toEqual(OFF)
  })

  it('keeps the rest of the Local Config, as the seed rule requires', async () => {
    const { written } = await run('access', {
      env: `${INSTALLED}GH_TOKEN=github_pat_captured\n`,
    })
    expect(readEnv(written ?? '', 'GH_TOKEN')).toBe('github_pat_captured')
    expect(readEnv(written ?? '', 'WORKSPACE_ROOT')).toBe('/home/op/work')
  })

  it('changes nothing when the operator backs out', async () => {
    const { result, written } = await run(null)
    expect(written).toBeUndefined()
    expect(result).toEqual(OFF)
  })

  // The criterion: against a Target this CLI has never installed to, say so
  // rather than writing a toggle into a file the stack does not read yet.
  it('says nothing is installed, rather than failing obscurely', async () => {
    const { result, written, shown, asked } = await run('sessions', { env: '' })
    expect(shown).toContain('Nothing is installed here')
    expect(written).toBeUndefined()
    expect(asked).toEqual([])
    expect(result).toBeUndefined()
  })

  it('tells an unreachable Target apart from an empty one', async () => {
    await expect(run('sessions', { code: 255 })).rejects.toThrow(/connect to host/)
  })
})
