import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { serve as serveInngest } from 'inngest/hono'
import { z } from 'zod'
import { env } from './env.js'
import { sandcastleRun } from './functions/run.js'
import { inngest, runRequested, runRequestedData } from './inngest.js'
import { listProjects, resolveProject } from './projects.js'
import { locateRun, resolveRunFile, runPageUrl, validateRunId } from './run-logs/run-dir.js'

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
  /** Every checkout under the workspace root, Onboarded or not. */
  readonly listProjects: () => Promise<unknown>
  /** The run directory for an id, under whichever Project holds it. */
  readonly locateRun: (id: string) => Promise<string | undefined>
  /** Where the run page for an id is, from the Harness's own port. */
  readonly runPageUrl: (id: string) => string
}

const liveDeps: AppDeps = {
  dispatch: (data) => inngest.send(runRequested.create(data)),
  resolveProject: (project) => resolveProject(env.workspaceRoot, project),
  listProjects: () => listProjects(env.workspaceRoot),
  locateRun: (id) => locateRun(env.workspaceRoot, id),
  runPageUrl: (id) => runPageUrl(env.port, id),
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The run page, read once. It ships in `src/` beside this file — a single
 *  dependency-free HTML file that fetches its Run's `events.jsonl` itself. */
let runPage: Promise<string> | undefined
const loadRunPage = (): Promise<string> => {
  runPage ??= readFile(new URL('./run-logs/page.html', import.meta.url), 'utf8')
  return runPage
}

const isRunId = (id: string): boolean => {
  try {
    validateRunId(id)
    return true
  } catch {
    return false
  }
}

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
   * What the Harness can see, read-only.
   *
   * The Harness's own answer is the one worth having: a checkout is visible on
   * the Target's disk to anyone with a shell there, but only this process can
   * say whether the path-parity mount and `WORKSPACE_ROOT` agree well enough
   * for a Dispatch to resolve it. That is what Onboarding checks when it
   * finishes, and what a status report asks for.
   *
   * Nothing here queues a Run. Confirming that Onboarding worked by dispatching
   * a real one would start an agent, spend subscription usage, and leave a Task
   * Branch behind — a side effect nobody asked for, to learn something a
   * question can answer.
   */
  app.get('/projects', async (c) => c.json({ projects: await deps.listProjects() }))

  app.get('/projects/:name', async (c) => {
    try {
      return c.json(await deps.resolveProject(c.req.param('name')))
    } catch (error) {
      // 404, where a Dispatch answers 400 for the same condition: there, an
      // unresolvable Project makes the request wrong; here, "it is not there"
      // is the answer being asked for.
      return c.json({ error: detail(error) }, 404)
    }
  })

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
      // The link, before the Run starts: the run directory is keyed by this
      // id, so the live tail is one click away from the moment of Dispatch.
      return c.json({ ids, logs: ids.map((id) => deps.runPageUrl(id)) }, 202)
    },
  )

  // Registered after the POST above, so it only catches the other methods:
  // Hono would otherwise answer them with a bare 404, which reads as "no such
  // endpoint" rather than "wrong verb".
  app.all('/dispatch', (c) => c.json({ error: 'Use POST' }, 405))

  /**
   * A Run's directory, by the id its Dispatch answered with. Loopback only,
   * like everything else here: the tunnel the operator already opens for the
   * dashboard is the access path, and the Orchestrator's run page links here.
   *
   * The page is served for any well-formed id, started or not: the link is
   * handed out at Dispatch, and a queued Run has no directory yet. The page
   * tails `events.jsonl` itself and says so until it appears. The files are
   * served only once they exist, and only the ones a Run writes.
   */
  const page = async (c: { readonly req: { param: (name: string) => string } }) => {
    if (!isRunId(c.req.param('id'))) return undefined
    return loadRunPage()
  }
  app.get('/runs/:id', async (c) => {
    const html = await page(c)
    return html === undefined ? c.json({ error: 'Not a run id' }, 404) : c.html(html)
  })
  app.get('/runs/:id/*', async (c) => {
    const id = c.req.param('id')
    const rest = c.req.path.slice(`/runs/${id}/`.length)
    if (rest === '') {
      const html = await page(c)
      return html === undefined ? c.json({ error: 'Not a run id' }, 404) : c.html(html)
    }
    if (!isRunId(id)) return c.json({ error: 'Not a run id' }, 404)
    const dir = await deps.locateRun(id)
    if (!dir) return c.json({ error: `No Run ${id}` }, 404)
    const file = resolveRunFile(dir, rest)
    if (!file) return c.json({ error: `No such file in Run ${id}` }, 404)
    try {
      await stat(file.path)
    } catch {
      return c.json({ error: `Run ${id} has not written ${rest}` }, 404)
    }
    // Streamed rather than read whole: a transcript or a raw stream can run
    // to megabytes, and the page fetches the events file every two seconds.
    c.header('content-type', file.contentType)
    c.header('cache-control', 'no-store')
    return c.body(Readable.toWeb(createReadStream(file.path)) as ReadableStream)
  })

  // The Orchestrator's side of the same server: sync, introspection, and the
  // invocation of each Run. It reaches this by service name over the compose
  // network.
  app.all('/api/inngest', serveInngest({ client: inngest, functions: [sandcastleRun] }))

  return app
}
