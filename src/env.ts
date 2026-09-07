import { z } from 'zod'

/**
 * The harness's own runtime settings — orchestration only. Agent credentials
 * and sandbox images belong to each Project, not here: they come from that
 * Project's `.sandcastle/` via sandcastle's own resolvers (ADR 0003).
 *
 * The Inngest keys are deliberately absent: the SDK reads them from the
 * environment itself, and its dev mode changes which of them are needed at
 * all. Restating them here would be a second, disagreeing source of truth.
 */
const schema = z.object({
  /** Path to the directory containing the Project checkouts. The same path on
   *  the Target and inside the Harness container — a Sandbox's bind mounts are
   *  created by the Target's daemon, so parity is required, and a relative
   *  path would silently resolve against whatever the process's cwd happens to
   *  be. */
  WORKSPACE_ROOT: z
    .string()
    .min(1)
    .startsWith('/', 'must be an absolute path — it is also a path on the Target'),
  /** Model for the sandbox agent unless a Dispatch overrides it. */
  AGENT_MODEL: z.string().min(1).default('claude-opus-4-8'),
  /** Address the harness binds, inside its own container namespace. The
   *  Harness is a container (ADR 0006): what is reachable on the Target is
   *  decided by the compose `ports` mapping, which publishes this port on
   *  Target loopback only. Compose sets this to 0.0.0.0 so the published port
   *  and the Orchestrator can both reach it; the default stays loopback so
   *  running the server directly in development never widens itself. */
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
})

export interface Env {
  readonly workspaceRoot: string
  readonly defaultModel: string
  readonly host: string
  readonly port: number
}

/**
 * Read the settings out of an environment, or say precisely what is wrong with
 * it. Pure, so the failures are testable without a process to kill.
 */
export const parseEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    throw new Error(`Incomplete environment:\n${z.prettifyError(parsed.error)}`)
  }
  return {
    workspaceRoot: parsed.data.WORKSPACE_ROOT,
    defaultModel: parsed.data.AGENT_MODEL,
    host: parsed.data.HOST,
    port: parsed.data.PORT,
  }
}

/**
 * Settings for this process, read once at startup.
 *
 * A misconfigured Harness used to start, sync, look healthy, and fail on the
 * first Dispatch — by which point the operator is reading a failed Run in the
 * Orchestrator to find out that a variable was missing. Failing here instead
 * means compose reports the container as restarting, and the reason is the
 * first thing in its log.
 */
export const env: Env = (() => {
  try {
    return parseEnv()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()
