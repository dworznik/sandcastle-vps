import { describe, expect, it, vi } from 'vitest'
import { createApp, type AppDeps } from './app.js'

const dispatched = () => vi.fn(async () => ({ ids: ['01JQ8ZK0'] }))

const app = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    dispatch: dispatched(),
    resolveProject: async () => ({}),
    listProjects: async () => [],
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
    expect(await response.json()).toEqual({ ids: ['01JQ8ZK0'] })
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
