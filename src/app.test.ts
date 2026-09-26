import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'

const dispatched = () => vi.fn(async () => ({ ids: ['01JQ8ZK0'] }))

const app = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    dispatch: dispatched(),
    resolveProject: async () => ({}),
    listProjects: async () => [],
    locateRun: async () => undefined,
    runPageUrl: (id) => `http://127.0.0.1:3000/runs/${id}`,
    secrets: ['sk-ant-oat01-fixture-token'],
    harnessSynced: async () => true,
    ...overrides,
  })

const post = (body: unknown, overrides?: Partial<AppDeps>) =>
  app(overrides).request('/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('GET /health', () => {
  // The installer waits on this to decide the Harness is up. The Inngest
  // routes answer 401 to an unsigned request, so they cannot serve that.
  it('answers a plain unsigned request', async () => {
    const response = await app().request('/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })
})

/**
 * The Harness's own answer about what it can see. The wizard can read the
 * Target's disk over the Connector without asking anything; what it cannot
 * establish that way is whether the path-parity mount and `WORKSPACE_ROOT`
 * line up well enough for a Dispatch to resolve a checkout — which is the
 * failure Onboarding needs to catch, and the one this route exists to answer.
 */
describe('GET /projects', () => {
  const summary = {
    name: 'todo-app',
    path: '/home/op/work/todo-app',
    imageName: 'sandcastle:todo-app',
    onboarded: true,
  }

  it('lists what the Harness sees under its workspace root', async () => {
    const response = await app({ listProjects: async () => [summary] }).request('/projects')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ projects: [summary] })
  })

  it('answers with an empty list for a Target that has no checkouts yet', async () => {
    expect(await (await app().request('/projects')).json()).toEqual({ projects: [] })
  })

  it('answers for one Project by name', async () => {
    const response = await app({ resolveProject: async () => summary }).request(
      '/projects/todo-app',
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(summary)
  })

  // 404 rather than the 400 a Dispatch answers with: this is a question about
  // whether a Project is there, and "no" is an answer to it rather than a
  // malformed request.
  it('answers 404, carrying the reason, for a checkout that was never Onboarded', async () => {
    const response = await app({
      resolveProject: async () => {
        throw new Error('Project "todo-app" has not been Onboarded')
      },
    }).request('/projects/todo-app')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Project "todo-app" has not been Onboarded' })
  })

  it('changes nothing — a Dispatch is the only thing that queues a Run', async () => {
    const dispatch = dispatched()
    await app({ dispatch, resolveProject: async () => summary }).request('/projects/todo-app')
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('POST /dispatch', () => {
  it("queues the Run and answers with the Orchestrator's ids", async () => {
    const dispatch = dispatched()
    const response = await post(
      { project: 'todo-app', task: 'Fix the flaky login test' },
      { dispatch },
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      ids: ['01JQ8ZK0'],
      logs: ['http://127.0.0.1:3000/runs/01JQ8ZK0'],
    })
    expect(dispatch).toHaveBeenCalledWith({ project: 'todo-app', task: 'Fix the flaky login test' })
  })

  it('carries the optional Task Branch and model through untouched', async () => {
    const dispatch = dispatched()
    await post(
      { project: 'todo-app', task: 'Fix it', branch: 'sandcastle/login', model: 'claude-opus-4-8' },
      { dispatch },
    )

    expect(dispatch).toHaveBeenCalledWith({
      project: 'todo-app',
      task: 'Fix it',
      branch: 'sandcastle/login',
      model: 'claude-opus-4-8',
    })
  })

  // The dispatcher would otherwise have to go and read a failed Run in the
  // Orchestrator to find out the checkout was never Onboarded.
  it('refuses a Project it cannot resolve, and says why', async () => {
    const dispatch = dispatched()
    const response = await post(
      { project: 'nope', task: 'Fix it' },
      {
        dispatch,
        resolveProject: async () => {
          throw new Error('Project "nope" has not been Onboarded')
        },
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Project "nope" has not been Onboarded' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  // The cold-start window (#44): an event the Orchestrator accepts before it
  // has synced the Harness never becomes a Run. So until it says the Harness
  // is synced, a Dispatch is refused with a status that says "not yet" rather
  // than "no" — and nothing is sent.
  it('answers 503 with Retry-After, and sends nothing, until the Orchestrator has synced the Harness', async () => {
    const dispatch = dispatched()
    const response = await post(
      { project: 'todo-app', task: 'Fix it' },
      { dispatch, harnessSynced: async () => false },
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('2')
    expect(await response.json()).toEqual({
      error:
        'The Orchestrator has not synced the Harness yet, or is not answering; retry in a moment.',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })

  // Not synced is checked after the Project resolves: a Dispatch that is
  // wrong should learn that, not be told to retry something that can never
  // succeed.
  it('refuses an unresolvable Project even while the Orchestrator is not synced', async () => {
    const response = await post(
      { project: 'nope', task: 'Fix it' },
      {
        harnessSynced: async () => false,
        resolveProject: async () => {
          throw new Error('Project "nope" has not been Onboarded')
        },
      },
    )

    expect(response.status).toBe(400)
  })

  it('names what was wrong with an unusable payload', async () => {
    const response = await post({ project: 'todo-app' })

    expect(response.status).toBe(400)
    const { error } = (await response.json()) as { error: string }
    expect(error).toContain('task')
  })

  // Hono raises this one before any handler runs, so it is the case most
  // likely to answer in a different shape from every other error.
  it('answers a body that is not JSON in the same shape as every other error', async () => {
    const response = await post('{not json')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('JSON') })
  })

  it('tells a GET which verb to use, rather than reporting no such endpoint', async () => {
    const response = await app().request('/dispatch')

    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: 'Use POST' })
  })

  it('turns an Orchestrator that is down into a 500, not a stack trace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await post(
      { project: 'todo-app', task: 'Fix it' },
      {
        dispatch: async () => {
          throw new Error('connect ECONNREFUSED 172.18.0.2:8288')
        },
      },
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Dispatch failed' })
    vi.restoreAllMocks()
  })
})

/**
 * A Run's directory, served back by the id the Dispatch answered with. The
 * page is a viewer for an id, so it is served for any well-formed one and
 * tails the events itself — the link is handed out before the Run starts,
 * and a queued Run has no directory yet. The files are served only once
 * they exist.
 */
describe('GET /runs', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sandcastle-app-'))
    await writeFile(join(dir, 'events.jsonl'), '{"type":"run.started"}\n')
    // sandcastle writes this one itself, so it is the file only the route
    // can scrub. Token-shaped and under 80 characters, per .gitleaks.toml.
    await writeFile(join(dir, 'sandcastle.log'), 'started\n$ echo sk-ant-oat01-fixture-token\n')
    await mkdir(join(dir, 'session', 'subagents'), { recursive: true })
    await writeFile(join(dir, 'session', 'sess-1.jsonl'), '{"type":"user"}\n')
    await writeFile(join(dir, 'session', 'subagents', 'agent-a1.jsonl'), '{}\n')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const located = () => app({ locateRun: async (id) => (id === '01K5A' ? dir : undefined) })

  it('serves the run page for an id, whether or not its Run has started', async () => {
    for (const path of ['/runs/01K5A', '/runs/01K5A/', '/runs/01K5NOTYET']) {
      const response = await located().request(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('events.jsonl')
    }
  })

  it('answers 404 to an id that could not be a run id', async () => {
    const response = await located().request('/runs/..%2Fetc')
    expect(response.status).toBe(404)
  })

  it('serves the events as newline-delimited JSON', async () => {
    const response = await located().request('/runs/01K5A/events.jsonl')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('{"type":"run.started"}\n')
  })

  it("serves sandcastle's rendered log as text", async () => {
    const response = await located().request('/runs/01K5A/sandcastle.log')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await response.text()).toBe('started\n$ echo [redacted]\n')
  })

  // The Run scrubs what it writes; sandcastle's own log is written by
  // sandcastle, so the route is the one place every served file goes through.
  it('scrubs the Harness’s secrets from whatever it serves', async () => {
    const text = await (await located().request('/runs/01K5A/sandcastle.log')).text()
    expect(text).not.toContain('sk-ant-oat01-fixture-token')
  })

  it('serves the transcript and the subagent transcripts under session/', async () => {
    expect((await located().request('/runs/01K5A/session/sess-1.jsonl')).status).toBe(200)
    expect((await located().request('/runs/01K5A/session/subagents/agent-a1.jsonl')).status).toBe(
      200,
    )
  })

  it('answers 404 for a Run no Project has', async () => {
    const response = await located().request('/runs/01K5B/events.jsonl')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'No Run 01K5B' })
  })

  it('answers 404 for a file a Run does not write, or has not written yet', async () => {
    expect((await located().request('/runs/01K5A/stream.jsonl')).status).toBe(404)
    expect((await located().request('/runs/01K5A/index.html')).status).toBe(404)
    expect((await located().request('/runs/01K5A/session/notes.txt')).status).toBe(404)
    expect((await located().request('/runs/01K5A/..%2F..%2F.env')).status).toBe(404)
  })

  it('changes nothing — a Dispatch is the only thing that queues a Run', async () => {
    const dispatch = dispatched()
    await app({ dispatch, locateRun: async () => dir }).request('/runs/01K5A/events.jsonl')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
