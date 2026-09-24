import { execFile } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { validateBranch } from './branch.js'
import { slugFromRemote } from './repo.js'

/**
 * Delivery: publishing a completed Run's Task Branch as a pull request, and
 * resolving the Base that pull request proposes it against.
 *
 * Both halves belong here because they are the same decision seen from two
 * ends — the Base is what a Task Branch is cut from *and* what its pull request
 * targets, and getting one without the other produces a pull request that
 * proposes commits already on the Base.
 *
 * The effects are two ports, `git` and `github`, so every decision this module
 * makes is exercisable without a checkout or a network. Neither port throws for
 * an answer it got: a non-zero git exit and a 404 are answers, and which of
 * them is fatal is this module's judgement rather than the port's.
 */

const exec = promisify(execFile)

/** git in a Project checkout is local work plus one network round-trip; a minute
 *  is generous for both and short enough to fail a hung fetch legibly. */
const GIT_TIMEOUT_MS = 60 * 1000
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const GITHUB_TIMEOUT_MS = 30 * 1000

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface GitHubRequest {
  readonly method: 'GET' | 'POST'
  /** Path under `https://api.github.com`, already encoded. */
  readonly path: string
  readonly body?: unknown
}

export interface GitHubResponse {
  readonly status: number
  readonly body: unknown
}

export interface DeliveryPorts {
  /** git, run in the Project checkout, authenticated for the remote. */
  readonly git: (args: readonly string[]) => Promise<GitResult>
  readonly github: (request: GitHubRequest) => Promise<GitHubResponse>
}

// ------------------------------------------------------------ authenticated git

/**
 * What git calls to answer a credential prompt.
 *
 * The token is named, never interpolated. A credential on a command line
 * reaches `ps` and every log that echoes a command, which is the rule
 * `GIT_SETUP_COMMAND` and the Onboarding scripts already follow. The
 * consequence worth stating: this script holds no secret, so it can be written
 * once per process and left on disk.
 *
 * git asks twice — for a username and then a password — and distinguishes the
 * two only by the prompt text it passes as `$1`. A script that answered both
 * the same way would send the token as the username and then fail to
 * authenticate.
 */
export const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$GH_TOKEN" ;;
esac
`

const ASKPASS_PATH = join(tmpdir(), 'sandcastle-git-askpass.sh')

let written: Promise<string> | undefined

/** Write the askpass script once per process. `writeFile`'s mode applies only
 *  when it creates the file, so the mode is set separately — an askpass git
 *  cannot execute fails as an authentication failure, which reads as the wrong
 *  problem entirely. */
const askpassScript = (): Promise<string> =>
  (written ??= (async () => {
    await writeFile(ASKPASS_PATH, GIT_ASKPASS_SCRIPT)
    await chmod(ASKPASS_PATH, 0o700)
    return ASKPASS_PATH
  })())

/**
 * The real ports, for one Project.
 *
 * Every git call is authenticated, not only the push: `git fetch` against a
 * private Project needs the token too, and a fetch that silently failed would
 * resolve a Base from a stale remote ref.
 */
export const deliveryPorts = (checkout: string, githubToken: string): DeliveryPorts => ({
  git: async (args) => {
    const env = {
      ...process.env,
      GH_TOKEN: githubToken,
      GIT_ASKPASS: await askpassScript(),
      // No terminal to answer a prompt on, so a credential the askpass script
      // cannot supply must fail rather than hang until the timeout.
      GIT_TERMINAL_PROMPT: '0',
    }
    try {
      const { stdout, stderr } = await exec('git', [...args], {
        cwd: checkout,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
      })
      return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string }
      // A numeric `code` is git's own exit status, which is an answer. Anything
      // else — ENOENT, a timeout kill — is this process failing to ask.
      if (typeof failed.code !== 'number') throw error
      return {
        code: failed.code,
        stdout: (failed.stdout ?? '').trim(),
        stderr: (failed.stderr ?? '').trim(),
      }
    }
  },
  github: async ({ method, path, body }) => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await fetch(`https://api.github.com${path}`, init)
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed }
  },
})

// ------------------------------------------------------------------ git helpers

/** Run git and insist it succeeded, naming what was being attempted. git says
 *  what went wrong on stderr; the caller's phrasing says what it was for. */
const gitOut = async (
  ports: DeliveryPorts,
  args: readonly string[],
  what: string,
): Promise<string> => {
  const { code, stdout, stderr } = await ports.git(args)
  if (code !== 0) {
    throw new Error(`${what} failed (git exit ${code}): ${stderr || stdout || '(no output)'}`)
  }
  return stdout
}

/** Whether git answered yes — for the questions where "no" is not a failure. */
const gitOk = async (ports: DeliveryPorts, args: readonly string[]): Promise<boolean> =>
  (await ports.git(args)).code === 0

// -------------------------------------------------------------------- the Base

/**
 * Where a Task Branch's Base is recorded: against the branch, in the Project
 * checkout's own config.
 *
 * git's own per-branch namespace, so it travels with the branch, survives the
 * worktree being removed, and is deleted with the branch. A re-dispatch reads
 * it back rather than re-resolving, which is what makes "the same Base" and "a
 * conflicting Base" distinguishable at all.
 */
const baseConfigKey = (branch: string): string => `branch.${branch}.sandcastleBase`

export interface ResolvedBase {
  readonly base: string
  /** The ref a new Task Branch is cut from — a remote-tracking ref, freshly
   *  fetched, never the shared checkout's HEAD. */
  readonly startPoint: string
  /** The Base this Task Branch already recorded, when it had one. */
  readonly recorded: string | undefined
}

const repository = z.object({ default_branch: z.string().min(1) })

const apiDetail = (body: unknown): string => {
  const message = (body as { message?: unknown })?.message
  return typeof message === 'string' ? `: ${message}` : ''
}

/** The remote's default branch, asked of GitHub rather than read from the
 *  checkout's `origin/HEAD` — that ref is written at clone time and is stale or
 *  absent on a checkout the platform has held for months. */
const defaultBranch = async (ports: DeliveryPorts, slug: string): Promise<string> => {
  const { status, body } = await ports.github({ method: 'GET', path: `/repos/${slug}` })
  if (status !== 200) {
    throw new Error(
      `Could not ask GitHub for ${slug}'s default branch (HTTP ${status})${apiDetail(body)}. ` +
        `A Run's Base defaults to it, so name one in the Dispatch to proceed without it.`,
    )
  }
  const parsed = repository.safeParse(body)
  if (!parsed.success) {
    throw new Error(`GitHub answered about ${slug} without naming a default branch.`)
  }
  return parsed.data.default_branch
}

/**
 * Resolve the Base for a Run, before its Task Branch is cut.
 *
 * Fetches first, because every answer after this depends on the remote being
 * current: a Base verified against a stale remote-tracking ref produces a Task
 * Branch whose pull request proposes commits the Base already has.
 */
export const resolveBase = async (
  ports: DeliveryPorts,
  input: {
    readonly slug: string
    readonly branch: string
    /** The Base the Dispatch named, if it named one. */
    readonly requested?: string
  },
): Promise<ResolvedBase> => {
  // Before the fetch, so a malformed Base costs nothing: this value becomes a
  // ref and a pull request's `base`, and `validateBranch` is the same rule the
  // Task Branch itself is held to.
  const requested = input.requested === undefined ? undefined : validateBranch(input.requested)

  await gitOut(ports, ['fetch', '--quiet', 'origin'], 'Fetching the Project remote')

  const read = await ports.git(['config', '--get', baseConfigKey(input.branch)])
  const recorded = read.code === 0 && read.stdout ? read.stdout : undefined

  if (recorded && requested && recorded !== requested) {
    throw new Error(
      `The Task Branch ${input.branch} was cut from "${recorded}", and this Dispatch ` +
        `names "${requested}" as its Base. Re-dispatching continues a Task Branch, and ` +
        `rebasing one onto a different Base would rewrite commits that may already be ` +
        `proposed for review (ADR 0001). Dispatch to a new branch instead.`,
    )
  }

  const base = recorded ?? requested ?? (await defaultBranch(ports, input.slug))
  const startPoint = `refs/remotes/origin/${base}`
  if (!(await gitOk(ports, ['rev-parse', '--verify', '--quiet', startPoint]))) {
    throw new Error(
      `origin has no branch "${base}" to use as this Run's Base — nothing to cut ` +
        `${input.branch} from, and nothing to propose it against.`,
    )
  }
  return { base, startPoint, recorded }
}

/**
 * Record the Base against the Task Branch, once that branch exists.
 *
 * Deliberately after the Run rather than before it: a Run that failed before
 * creating its branch would otherwise leave a recorded Base behind, and the
 * next Dispatch naming a different one would be rejected on the strength of a
 * branch that was never cut.
 */
export const recordBase = async (
  ports: DeliveryPorts,
  branch: string,
  base: string,
): Promise<void> => {
  await gitOut(ports, ['config', baseConfigKey(branch), base], "Recording the Run's Base")
}

/** The Project's repository on GitHub, read from the remote Onboarding
 *  configured. A Project whose origin GitHub does not host cannot be Delivered
 *  to, and that is worth saying before a Run starts rather than after. */
export const projectSlug = async (ports: DeliveryPorts): Promise<string> => {
  const remote = await gitOut(
    ports,
    ['remote', 'get-url', 'origin'],
    "Reading the Project's origin remote",
  )
  const slug = slugFromRemote(remote)
  if (!slug) {
    throw new Error(
      `The Project's origin remote is ${remote || '(unset)'}, which is not a GitHub ` +
        `repository. A Run resolves its Base and opens its pull request there, so there ` +
        `is nothing to Deliver to.`,
    )
  }
  return slug
}
