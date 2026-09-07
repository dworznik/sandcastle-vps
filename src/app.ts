import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { serve as serveInngest } from 'inngest/hono'
import { z } from 'zod'
import { env } from './env.js'
import { sandcastleRun } from './functions/run.js'
import { inngest, runRequested, runRequestedData } from './inngest.js'
import { resolveProject } from './projects.js'

/**
 * The two effects a Dispatch has, injected so the routes can be exercised
 * without an Orchestrator or a workspace on disk. Everything else about a
 * request — parsing, validation, status codes — is the app's own.
 */
export interface AppDeps {
  /** Queue a Run; answers with the Orchestrator's ids for it. */
  readonly dispatch: (
    data: z.infer<typeof runRequestedData>,
  ) => Promise<{ readonly ids: readonly string[] }>
  /** Throws when the checkout is missing or was never Onboarded. */
  readonly resolveProject: (project: string) => Promise<unknown>
}

const liveDeps: AppDeps = {
  dispatch: (data) => inngest.send(runRequested.create(data)),
  resolveProject: (project) => resolveProject(env.workspaceRoot, project),
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const createApp = (deps: AppDeps = liveDeps): Hono => {
  const app = new Hono()

  // One error shape for every failure. Hono raises its own HTTPException
  // before a handler ever runs — a body that is not JSON is the one that
  // matters here — and without this it would answer in plain text while every
  // other error answered in JSON.
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status)
    }
    console.error('request failed', error)
    return c.json({ error: 'Dispatch failed' }, 500)
  })

  // Something that answers 2xx to an unsigned request. The Inngest routes
  // below cannot: they answer 401 to anything they cannot verify, which is
  // correct of them and useless as a sign of life.
  app.get('/health', (c) => c.json({ status: 'ok' }))

  /**
   * Keyless Dispatch surface for callers on the Target (loopback) — the
   * harness holds the Inngest event key so dispatchers don't have to.
   * Reachability is the access control: compose publishes this port on Target
   * loopback and nowhere else.
   */
  app.post(
    '/dispatch',
    zValidator('json', runRequestedData, (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    }),
    async (c) => {
      const data = c.req.valid('json')
      // Resolve the Project up front so a dispatcher learns that a checkout is
      // missing or not Onboarded here, rather than having to go read a failed
      // Run in the Orchestrator. The Run resolves it again — this is a
      // courtesy, not the guard.
      try {
        await deps.resolveProject(data.project)
      } catch (error) {
        return c.json({ error: detail(error) }, 400)
      }
      const { ids } = await deps.dispatch(data)
      return c.json({ ids }, 202)
    },
  )

  // Registered after the POST above, so it only catches the other methods:
  // Hono would otherwise answer them with a bare 404, which reads as "no such
  // endpoint" rather than "wrong verb".
  app.all('/dispatch', (c) => c.json({ error: 'Use POST' }, 405))

  // The Orchestrator's side of the same server: sync, introspection, and the
  // invocation of each Run. It reaches this by service name over the compose
  // network.
  app.all('/api/inngest', serveInngest({ client: inngest, functions: [sandcastleRun] }))

  return app
}
