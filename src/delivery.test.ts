import { describe, expect, it } from 'vitest'
import { GIT_ASKPASS_SCRIPT, recordBase, resolveBase, type DeliveryPorts } from './delivery.js'

/**
 * A git that answers only what a test registered, keyed by the command line it
 * would have run. Anything else is a test failure rather than a plausible
 * "no" — the difference between "that ref is absent" and "nobody expected that
 * command" is exactly what a permissive fake would hide.
 */
const fakeGit = (answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) => {
  const calls: string[][] = []
  const git: DeliveryPorts['git'] = async (args) => {
    calls.push([...args])
    const answer = answers[args.join(' ')]
    if (!answer) throw new Error(`no answer registered for: git ${args.join(' ')}`)
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { git, calls }
}

const fakeGitHub = (answers: Record<string, { status: number; body: unknown }>) => {
  const calls: string[] = []
  const github: DeliveryPorts['github'] = async ({ method, path }) => {
    calls.push(`${method} ${path}`)
    const answer = answers[`${method} ${path}`]
    if (!answer) throw new Error(`no answer registered for: ${method} ${path}`)
    return answer
  }
  return { github, calls }
}

const FETCH = 'fetch --quiet origin'
const CONFIG_GET = 'config --get branch.sandcastle/task.sandcastleBase'
const VERIFY_MAIN = 'rev-parse --verify --quiet refs/remotes/origin/main'

/** What a checkout answers when the Task Branch has no recorded Base yet. */
const unrecorded = { [FETCH]: {}, [CONFIG_GET]: { code: 1 }, [VERIFY_MAIN]: { stdout: 'abc123' } }

describe('resolveBase', () => {
  it('takes the Base a Dispatch names', async () => {
    const { git } = fakeGit(unrecorded)
    const { github } = fakeGitHub({})
    await expect(
      resolveBase({ git, github }, { slug: 'o/r', branch: 'sandcastle/task', requested: 'main' }),
    ).resolves.toEqual({
      base: 'main',
      startPoint: 'refs/remotes/origin/main',
      recorded: undefined,
    })
  })

  // The remote's default branch, not the checkout's `origin/HEAD`: that ref is
  // written once at clone time and can be stale or absent on a long-lived
  // shared checkout.
  it('asks GitHub for the default branch when a Dispatch names no Base', async () => {
    const { git } = fakeGit(unrecorded)
    const { github, calls } = fakeGitHub({
      'GET /repos/o/r': { status: 200, body: { default_branch: 'main' } },
    })
    await expect(
      resolveBase({ git, github }, { slug: 'o/r', branch: 'sandcastle/task' }),
    ).resolves.toMatchObject({ base: 'main' })
    expect(calls).toEqual(['GET /repos/o/r'])
  })

  // ADR 0001's hazard in a new place: the operator's HEAD in a shared checkout
  // must not silently become the agent's starting point.
  it('cuts from the fetched remote ref rather than from whatever HEAD is', async () => {
    const { git, calls } = fakeGit(unrecorded)
    const { github } = fakeGitHub({})
    const resolved = await resolveBase(
      { git, github },
      { slug: 'o/r', branch: 'sandcastle/task', requested: 'main' },
    )
    expect(resolved.startPoint).toBe('refs/remotes/origin/main')
    expect(calls[0]).toEqual(['fetch', '--quiet', 'origin'])
  })

  it('refuses a Base the remote does not have', async () => {
    const { git } = fakeGit({ ...unrecorded, [VERIFY_MAIN]: { code: 1 } })
    const { github } = fakeGitHub({})
    await expect(
      resolveBase({ git, github }, { slug: 'o/r', branch: 'sandcastle/task', requested: 'main' }),
    ).rejects.toThrow(/origin has no branch "main"/)
  })

  it('refuses a Base that is not a usable branch name', async () => {
    const { git } = fakeGit({})
    const { github } = fakeGitHub({})
    await expect(
      resolveBase({ git, github }, { slug: 'o/r', branch: 'sandcastle/task', requested: '../etc' }),
    ).rejects.toThrow(/Invalid branch name/)
  })

  describe('re-dispatched to a Task Branch that already records its Base', () => {
    const recorded = { ...unrecorded, [CONFIG_GET]: { stdout: 'main' } }

    it('reads the Base back rather than resolving it again', async () => {
      const { git } = fakeGit(recorded)
      const { github, calls } = fakeGitHub({})
      await expect(
        resolveBase({ git, github }, { slug: 'o/r', branch: 'sandcastle/task' }),
      ).resolves.toEqual({
        base: 'main',
        startPoint: 'refs/remotes/origin/main',
        recorded: 'main',
      })
      expect(calls).toEqual([])
    })

    it('ignores a Dispatch that names the same Base', async () => {
      const { git } = fakeGit(recorded)
      const { github } = fakeGitHub({})
      await expect(
        resolveBase({ git, github }, { slug: 'o/r', branch: 'sandcastle/task', requested: 'main' }),
      ).resolves.toMatchObject({ base: 'main' })
    })

    // Rebasing an existing Task Branch onto a different Base is the work-eating
    // surprise ADR 0001 exists to prevent, so the Dispatch is refused instead.
    it('rejects a Dispatch that names a conflicting Base', async () => {
      const { git } = fakeGit(recorded)
      const { github } = fakeGitHub({})
      await expect(
        resolveBase(
          { git, github },
          { slug: 'o/r', branch: 'sandcastle/task', requested: 'release' },
        ),
      ).rejects.toThrow(/was cut from "main".*names "release"/s)
    })
  })
})

describe('recordBase', () => {
  it('records the Base against the branch, where a re-dispatch reads it', async () => {
    const { git, calls } = fakeGit({
      'config branch.sandcastle/task.sandcastleBase main': {},
    })
    await recordBase({ git, github: fakeGitHub({}).github }, 'sandcastle/task', 'main')
    expect(calls).toEqual([['config', 'branch.sandcastle/task.sandcastleBase', 'main']])
  })
})

// The token is named, never interpolated: a value on a command line reaches
// `ps` and any log that echoes a command. The same rule GIT_SETUP_COMMAND and
// the Onboarding scripts follow, which is why this asserts on the text.
describe('GIT_ASKPASS_SCRIPT', () => {
  it('reads the token from the environment', () => {
    expect(GIT_ASKPASS_SCRIPT).toContain('"$GH_TOKEN"')
  })

  it('answers the username prompt with the token-bearer name git expects', () => {
    expect(GIT_ASKPASS_SCRIPT).toContain('x-access-token')
  })

  // git distinguishes its two prompts only by the text it passes as $1, so a
  // script that answered both the same way would send the token as a username.
  it('tells the two prompts apart', () => {
    expect(GIT_ASKPASS_SCRIPT).toContain('case "$1" in')
  })
})
