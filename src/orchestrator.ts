import { APP_ID } from './app-id.js'

/**
 * What the Orchestrator can be asked about the Harness, without the Inngest
 * client: `apps` is the Orchestrator's own view of what has synced with it,
 * on the GraphQL surface its dashboard uses. The creator CLI asks the same
 * question from outside the Target after an install; the Harness asks it from
 * inside before every Dispatch.
 */
export const APPS_QUERY = '{ apps { name url connected functionCount error } }'

export interface OrchestratorApp {
  readonly name?: string
  readonly url?: string
  readonly connected?: boolean
  readonly functionCount?: number
  readonly error?: string | null
}

/**
 * Has the Orchestrator synced this Harness, with its Run function registered?
 *
 * The cold-start window (#44): after `compose up` the Orchestrator's event API
 * is up seconds before it has synced the Harness, and an event it accepts in
 * that window is stored but never routed — no Run is ever created for it, and
 * nothing replays it once the Harness syncs. Measured at about 3.5 seconds on
 * a cold stack, and the event was lost both times. So the Dispatch surface
 * asks this before it sends anything; the reasoning for closing the window
 * here rather than by ordering the containers is beside `depends_on` in
 * compose.yaml.
 *
 * False for everything that is not a clear yes: unreachable, slow past the
 * timeout, an error status, a body that is not the schema, no app, some other
 * app, this app with an error or without its function. Each of those means an
 * event sent now would go into the void.
 */
export const harnessSynced = async (
  orchestratorUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> => {
  try {
    const response = await fetchImpl(`${orchestratorUrl}/v0/gql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: APPS_QUERY }),
      // A hung Orchestrator must not hang every Dispatch behind it.
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: { apps?: OrchestratorApp[] } }
    const app = body.data?.apps?.find((candidate) => candidate.name === APP_ID)
    return app?.connected === true && !app.error && (app.functionCount ?? 0) > 0
  } catch {
    return false
  }
}
