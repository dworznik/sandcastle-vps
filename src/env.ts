import { z } from 'zod'

/**
 * The Harness's own runtime settings: orchestration, plus the agent's
 * credentials.
 *
 * The credentials are the Harness's, not each Project's — ADR 0006 amends ADR
 * 0003's clause on that. They are optional here on purpose: the install brings
 * the stack up before the wizard has captured anything, and a Harness that
 * refused to start would leave the operator with a restart loop instead of a
 * running stack to add credentials to. A Run names what is missing instead;
 * see `agentSandbox`.
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

  // ------------------------------------------------------------ credentials
  //
  // Each is `.optional()` after trimming an empty string away, because the
  // Target's environment file scaffolds every key with an empty value: `KEY=`
  // means "not captured yet", and reading it as the empty string would turn a
  // missing credential into an unauthenticated Run.

  /** The agent's Claude Code token, passed into each Sandbox under this name —
   *  which is the name sandcastle's own resolver and Claude Code both use. */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  /** Fine-grained PAT the Sandbox pushes and opens pull requests with. */
  GH_TOKEN: z.string().min(1).optional(),
  /** Who a Run's commits are authored by. */
  AGENT_GIT_NAME: z.string().min(1).optional(),
  AGENT_GIT_EMAIL: z.string().min(1).optional(),
  /** The ed25519 signing key, at the path it has *on the Target*: the Sandbox's
   *  mount is created by the Target's daemon, and the Harness only reaches it
   *  at all because compose mounts the secrets directory at path parity. */
  AGENT_SIGNING_KEY: z
    .string()
    .min(1)
    .startsWith('/', 'must be an absolute path — it is also a path on the Target')
    .optional(),
})

/**
 * What a Run needs to commit, sign and push as the operator. Held whole or not
 * at all: a partial identity would produce unsigned commits or a Run that gets
 * as far as `git push` before failing.
 */
export interface AgentCredentials {
  readonly agentToken: string
  readonly githubToken: string
  readonly gitName: string
  readonly gitEmail: string
  /** Absolute path to the private key, identical on the Target and here. */
  readonly signingKeyPath: string
}

export interface Env {
  readonly workspaceRoot: string
  readonly defaultModel: string
  readonly host: string
  readonly port: number
  /** Whatever of the agent's identity the Target has been given so far. */
  readonly credentials: Partial<AgentCredentials>
}

/** The credential values that are secrets — the two tokens. The author
 *  identity and the key's path are not, and the key itself never leaves its
 *  file. Whatever a Run writes or serves is scrubbed of these. */
export const secretValues = (credentials: Partial<AgentCredentials>): string[] =>
  [credentials.agentToken, credentials.githubToken].filter((value): value is string => !!value)

/** The environment key each credential is read from, for error messages that
 *  name something the operator can actually go and set. */
export const CREDENTIAL_KEYS: Readonly<Record<keyof AgentCredentials, string>> = {
  agentToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  githubToken: 'GH_TOKEN',
  gitName: 'AGENT_GIT_NAME',
  gitEmail: 'AGENT_GIT_EMAIL',
  signingKeyPath: 'AGENT_SIGNING_KEY',
}

/**
 * Read the settings out of an environment, or say precisely what is wrong with
 * it. Pure, so the failures are testable without a process to kill.
 */
export const parseEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  // `KEY=` is what the Target's environment file scaffolds, so drop the blanks
  // before parsing: the schema's `.min(1)` would otherwise reject the very
  // shape a Target has between install and credential capture.
  const given = { ...source }
  for (const key of Object.values(CREDENTIAL_KEYS)) {
    if ((given[key] ?? '').trim() === '') delete given[key]
  }
  const parsed = schema.safeParse(given)
  if (!parsed.success) {
    throw new Error(`Incomplete environment:\n${z.prettifyError(parsed.error)}`)
  }
  const data = parsed.data
  return {
    workspaceRoot: data.WORKSPACE_ROOT,
    defaultModel: data.AGENT_MODEL,
    host: data.HOST,
    port: data.PORT,
    credentials: {
      agentToken: data.CLAUDE_CODE_OAUTH_TOKEN,
      githubToken: data.GH_TOKEN,
      gitName: data.AGENT_GIT_NAME,
      gitEmail: data.AGENT_GIT_EMAIL,
      signingKeyPath: data.AGENT_SIGNING_KEY,
    },
  }
}

/**
 * Settings for this process, read once at startup.
 *
 * A misconfigured Harness used to start, sync, look healthy, and fail on the
 * first Dispatch — by which point the operator is reading a failed Run in the
 * Orchestrator to find out that a variable was missing. Failing here instead
 * means compose reports the container as restarting, and the reason is the
 * first thing in its log. Credentials are the exception, and deliberately so:
 * see the schema above.
 */
export const env: Env = (() => {
  try {
    return parseEnv()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()
