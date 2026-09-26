import { describe, expect, it, vi } from 'vitest'
import { APP_ID } from './app-id.js'
import { harnessSynced } from './orchestrator.js'

const answering = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

const apps = (list: readonly unknown[]) => ({ data: { apps: list } })

describe('harnessSynced', () => {
  it('asks the Orchestrator for its apps, at its GraphQL surface', async () => {
    const fetchImpl = answering(apps([{ name: APP_ID, connected: true, functionCount: 1 }]))

    await harnessSynced('http://inngest:8288', fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://inngest:8288/v0/gql',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    )
  })

  it('is false when the app synced with an error', async () => {
    const fetchImpl = answering(
      apps([{ name: APP_ID, connected: true, functionCount: 1, error: 'signing key mismatch' }]),
    )

    expect(await harnessSynced('http://inngest:8288', fetchImpl)).toBe(false)
  })

  it('is true once this app is connected with its function registered', async () => {
    const fetchImpl = answering(apps([{ name: APP_ID, connected: true, functionCount: 1 }]))

    expect(await harnessSynced('http://inngest:8288', fetchImpl)).toBe(true)
  })

  // The cold-start window (#44), as the Orchestrator reports it.
  it('is false while the Orchestrator has synced no app', async () => {
    expect(await harnessSynced('http://inngest:8288', answering(apps([])))).toBe(false)
  })

  it('is false while this app is known but not connected', async () => {
    const fetchImpl = answering(apps([{ name: APP_ID, connected: false, functionCount: 0 }]))

    expect(await harnessSynced('http://inngest:8288', fetchImpl)).toBe(false)
  })

  it('is false when the app synced with no functions', async () => {
    const fetchImpl = answering(apps([{ name: APP_ID, connected: true, functionCount: 0 }]))

    expect(await harnessSynced('http://inngest:8288', fetchImpl)).toBe(false)
  })

  it('is false when only some other app is synced', async () => {
    const fetchImpl = answering(apps([{ name: 'other', connected: true, functionCount: 3 }]))

    expect(await harnessSynced('http://inngest:8288', fetchImpl)).toBe(false)
  })

  // Unreachable, not-yet-listening, or answering something that is not the
  // schema: none of these is a reason to send an event into the void.
  it('is false when the Orchestrator cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 172.18.0.2:8288')
    }) as unknown as typeof fetch

    expect(await harnessSynced('http://inngest:8288', fetchImpl)).toBe(false)
  })

  it('is false when the Orchestrator answers with an error status', async () => {
    expect(await harnessSynced('http://inngest:8288', answering({}, 502))).toBe(false)
  })

  it('is false when the answer is not the shape asked for', async () => {
    expect(await harnessSynced('http://inngest:8288', answering({ errors: [{}] }))).toBe(false)
  })
})
