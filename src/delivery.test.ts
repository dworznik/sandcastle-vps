import { describe, expect, it } from 'vitest'
import {
  DELIVERY_BACKOFF_MS,
  decideDelivery,
  deliver,
  deliveryNote,
  GIT_ASKPASS_SCRIPT,
  pullRequestBody,
  pullRequestTitle,
  recordBase,
  resolveBase,
  type DeliveryPorts,
} from './delivery.js'

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
  const sent: unknown[] = []
  const github: DeliveryPorts['github'] = async ({ method, path, body }) => {
    calls.push(`${method} ${path}`)
    if (body !== undefined) sent.push(body)
    const answer = answers[`${method} ${path}`]
    if (!answer) throw new Error(`no answer registered for: ${method} ${path}`)
    return answer
  }
  return { github, calls, sent }
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

describe('decideDelivery', () => {
  const facts = {
    branch: 'sandcastle/task',
    base: 'main',
    completed: true,
    commitsAhead: 2,
    openPullRequestUrl: undefined,
  }

  it('proposes the Task Branch when it is ahead of its Base and nothing proposes it yet', () => {
    expect(decideDelivery(facts)).toEqual({ outcome: 'delivered' })
  })

  // Re-dispatching to a Task Branch is the documented way to iterate, so the
  // second Run must land in the pull request the first one opened.
  it('updates the open pull request rather than opening a second one', () => {
    expect(decideDelivery({ ...facts, openPullRequestUrl: 'https://gh/pr/1' })).toEqual({
      outcome: 'updated',
      pullRequestUrl: 'https://gh/pr/1',
    })
  })

  // "Nothing to deliver" is about the branch, not about this Run: a re-dispatch
  // that added no commits still has work to report if an earlier Run left some.
  it('reports the open pull request even when this Run added nothing itself', () => {
    expect(
      decideDelivery({ ...facts, commitsAhead: 1, openPullRequestUrl: 'https://gh/pr/1' }),
    ).toMatchObject({ outcome: 'updated' })
  })

  it('has nothing to deliver when the Task Branch is not ahead of its Base', () => {
    const decision = decideDelivery({ ...facts, commitsAhead: 0 })
    expect(decision.outcome).toBe('nothing-to-deliver')
    expect(decision).toMatchObject({ reason: expect.stringContaining('not ahead of main') })
  })

  // A pull request that proposes nothing is not a pull request worth reporting
  // as live work, so the branch's position decides before its pull request does.
  it('still has nothing to deliver when a stale pull request is open', () => {
    expect(
      decideDelivery({ ...facts, commitsAhead: 0, openPullRequestUrl: 'https://gh/pr/1' }),
    ).toMatchObject({ outcome: 'nothing-to-deliver' })
  })

  // The Loop's one human gate is a merge. A pull request from a Run that did
  // not finish spends that attention on work nobody claims is done.
  it('skips Delivery for a Run that did not complete', () => {
    const decision = decideDelivery({
      ...facts,
      completed: false,
      incompleteReason: 'the agent failed',
    })
    expect(decision.outcome).toBe('skipped')
    expect(decision).toMatchObject({ reason: expect.stringContaining('the agent failed') })
  })

  // Distinguishably, which is the whole point of the discriminated outcome: a
  // flat boolean could not tell these two apart.
  it('says why it skipped rather than reading as nothing to deliver', () => {
    const skipped = decideDelivery({ ...facts, completed: false, commitsAhead: 0 })
    expect(skipped.outcome).toBe('skipped')
    expect(decideDelivery({ ...facts, commitsAhead: 0 }).outcome).toBe('nothing-to-deliver')
  })
})

describe('pullRequestTitle', () => {
  // The agent had to satisfy the Project's own commit conventions to commit at
  // all, so its subject is the one string on hand known to pass that repo's
  // title lint.
  it('takes the first commit’s subject', () => {
    expect(pullRequestTitle('feat(api): add a health route', 'add a health route please')).toBe(
      'feat(api): add a health route',
    )
  })

  it('falls back to the task text only when there is no usable subject', () => {
    expect(pullRequestTitle(undefined, 'Add a health\n  route')).toBe('Add a health route')
    expect(pullRequestTitle('   ', 'Add a health route')).toBe('Add a health route')
  })

  it('truncates a task long enough to blow a title cap', () => {
    const title = pullRequestTitle(undefined, 'x'.repeat(200))
    expect(title.length).toBeLessThanOrEqual(72)
  })
})

describe('pullRequestBody', () => {
  const body = pullRequestBody({
    task: 'Add a health route',
    base: 'main',
    provenance: {
      runId: '01JRUN',
      project: 'todo',
      target: 'sandcastle-vps',
      transcript: '/work/todo/.sandcastle/logs/sandcastle-task.log',
    },
  })

  it('carries the task text verbatim, which is what the agent was asked for', () => {
    expect(body).toContain('Add a health route')
  })

  it('carries the Run’s provenance, so a reviewer can find what produced it', () => {
    expect(body).toContain('01JRUN')
    expect(body).toContain('todo')
    expect(body).toContain('sandcastle-vps')
    expect(body).toContain('/work/todo/.sandcastle/logs/sandcastle-task.log')
  })
})

describe('deliver', () => {
  const AHEAD = 'rev-list --count refs/remotes/origin/main..refs/heads/sandcastle/task'
  const SUBJECTS = 'log --reverse --format=%s refs/remotes/origin/main..refs/heads/sandcastle/task'
  const PUSH = 'push origin refs/heads/sandcastle/task:refs/heads/sandcastle/task'
  const LOOKUP = 'GET /repos/o/r/pulls?state=open&head=o%3Asandcastle%2Ftask&per_page=1'
  const CREATE = 'POST /repos/o/r/pulls'

  const input = {
    slug: 'o/r',
    branch: 'sandcastle/task',
    base: 'main',
    completed: true,
    commits: ['aaa1111', 'bbb2222'],
    task: 'Add a health route',
    provenance: { runId: '01JRUN', project: 'todo', target: 'vps', transcript: '/logs/task.log' },
  }

  /** No waiting in tests; the backoff itself is asserted separately. */
  const noSleep = async () => {}

  it('pushes the Task Branch and opens a pull request against its Base', async () => {
    const { git, calls } = fakeGit({
      [AHEAD]: { stdout: '2' },
      [SUBJECTS]: { stdout: 'feat(api): add a health route\nfix: typo' },
      [PUSH]: {},
    })
    const { github, sent } = fakeGitHub({
      [LOOKUP]: { status: 200, body: [] },
      [CREATE]: { status: 201, body: { html_url: 'https://gh/pr/7' } },
    })

    await expect(deliver({ git, github }, input, noSleep)).resolves.toEqual({
      outcome: 'delivered',
      branch: 'sandcastle/task',
      base: 'main',
      pullRequestUrl: 'https://gh/pr/7',
    })
    expect(calls).toContainEqual([
      'push',
      'origin',
      'refs/heads/sandcastle/task:refs/heads/sandcastle/task',
    ])
    expect(sent).toEqual([
      {
        title: 'feat(api): add a health route',
        body: expect.stringContaining('Add a health route'),
        head: 'sandcastle/task',
        base: 'main',
      },
    ])
  })

  it('pushes and reports the existing pull request on a re-dispatch', async () => {
    const { git } = fakeGit({ [AHEAD]: { stdout: '3' }, [PUSH]: {} })
    const { github, calls } = fakeGitHub({
      [LOOKUP]: { status: 200, body: [{ html_url: 'https://gh/pr/7' }] },
    })

    await expect(deliver({ git, github }, input, noSleep)).resolves.toEqual({
      outcome: 'updated',
      branch: 'sandcastle/task',
      base: 'main',
      pullRequestUrl: 'https://gh/pr/7',
    })
    // No POST: a second pull request for the same head is the thing this avoids.
    expect(calls).toEqual([LOOKUP])
  })

  // Task Branch names are derived from task text and truncated, so name reuse
  // across time is expected. Reopening a merged pull request would re-propose
  // commits the Base already has, so only an *open* one counts as existing.
  it('opens a fresh pull request when the branch’s previous one was merged', async () => {
    const { git } = fakeGit({
      [AHEAD]: { stdout: '1' },
      [SUBJECTS]: { stdout: 'feat: again' },
      [PUSH]: {},
    })
    const { github, calls } = fakeGitHub({
      [LOOKUP]: { status: 200, body: [] },
      [CREATE]: { status: 201, body: { html_url: 'https://gh/pr/9' } },
    })

    await expect(deliver({ git, github }, input, noSleep)).resolves.toMatchObject({
      outcome: 'delivered',
      pullRequestUrl: 'https://gh/pr/9',
    })
    expect(calls).toEqual([LOOKUP, CREATE])
  })

  it('neither pushes nor opens anything when the branch is not ahead of its Base', async () => {
    const { git, calls } = fakeGit({ [AHEAD]: { stdout: '0' } })
    const { github, calls: apiCalls } = fakeGitHub({ [LOOKUP]: { status: 200, body: [] } })

    await expect(deliver({ git, github }, input, noSleep)).resolves.toMatchObject({
      outcome: 'nothing-to-deliver',
      reason: expect.stringContaining('not ahead of main'),
    })
    expect(calls.map((c) => c[0])).not.toContain('push')
    expect(apiCalls).toEqual([LOOKUP])
  })

  // A Run that did not complete touches nothing at all: its commits survive on
  // the Task Branch, and re-dispatching continues them.
  it('touches neither git nor GitHub for a Run that did not complete', async () => {
    const { git, calls } = fakeGit({})
    const { github, calls: apiCalls } = fakeGitHub({})

    await expect(
      deliver(
        { git, github },
        { ...input, completed: false, incompleteReason: 'the agent failed' },
        noSleep,
      ),
    ).resolves.toMatchObject({
      outcome: 'skipped',
      reason: expect.stringContaining('agent failed'),
    })
    expect(calls).toEqual([])
    expect(apiCalls).toEqual([])
  })

  // ADR 0002 forbids re-running the agent, so a transient API error must not be
  // allowed to discard twenty minutes of quota-burning work.
  it('retries a transient failure rather than losing the Run’s work', async () => {
    let attempts = 0
    const git: DeliveryPorts['git'] = async (args) => {
      if (args[0] === 'rev-list') {
        attempts += 1
        if (attempts === 1) return { code: 128, stdout: '', stderr: 'the remote hung up' }
        return { code: 0, stdout: '1', stderr: '' }
      }
      if (args[0] === 'log') return { code: 0, stdout: 'feat: work', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const { github } = fakeGitHub({
      [LOOKUP]: { status: 200, body: [] },
      [CREATE]: { status: 201, body: { html_url: 'https://gh/pr/7' } },
    })
    const waits: number[] = []

    await expect(
      deliver({ git, github }, input, async (ms) => {
        waits.push(ms)
      }),
    ).resolves.toMatchObject({ outcome: 'delivered' })
    expect(attempts).toBe(2)
    expect(waits).toEqual([DELIVERY_BACKOFF_MS[0]])
  })

  // The one outcome that must be impossible is a green Run with no pull
  // request, so an exhausted Delivery fails the Run and says where the work is.
  it('fails the Run once the retries are exhausted, naming the branch and its commits', async () => {
    const { git } = fakeGit({ [AHEAD]: { code: 128, stderr: 'permission denied' } })
    const { github } = fakeGitHub({})
    const waits: number[] = []

    await expect(
      deliver({ git, github }, input, async (ms) => {
        waits.push(ms)
      }),
    ).rejects.toThrow(/Delivery failed for sandcastle\/task.*permission denied.*aaa1111, bbb2222/s)
    expect(waits).toEqual([...DELIVERY_BACKOFF_MS])
  })
})

describe('deliveryNote', () => {
  const to = { branch: 'sandcastle/task', base: 'main' }

  it('names the pull request when there is one', () => {
    expect(deliveryNote({ outcome: 'delivered', ...to, pullRequestUrl: 'https://gh/pr/7' })).toBe(
      'delivered: https://gh/pr/7',
    )
    expect(deliveryNote({ outcome: 'updated', ...to, pullRequestUrl: 'https://gh/pr/7' })).toBe(
      'updated: https://gh/pr/7',
    )
  })

  it('names the reason when there is none', () => {
    expect(deliveryNote({ outcome: 'skipped', ...to, reason: 'the agent failed' })).toBe(
      'skipped: the agent failed',
    )
    expect(
      deliveryNote({ outcome: 'nothing-to-deliver', ...to, reason: 'not ahead of main' }),
    ).toBe('nothing-to-deliver: not ahead of main')
  })
})
