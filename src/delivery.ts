import { z } from 'zod'
import { validateBranch } from './branch.js'
import { errorDetail } from './errors.js'
import { slugFromRemote, slugOwner } from './repo.js'

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
 * them is fatal is this module's judgement rather than the port's. The ports
 * that actually reach a checkout and the API live in `delivery-ports.ts`, so
 * nothing here needs a subprocess or a socket to be read or tested.
 */

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
  return { base, startPoint }
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

// -------------------------------------------------------------------- Delivery

/**
 * What a Delivery decided to do, before any of it is done.
 *
 * Pure, and the reason this module is testable at all: whether a Task Branch is
 * ahead of its Base, whether something already proposes it, and which of the
 * four outcomes follows are one decision over facts, not a sequence of network
 * calls with judgement scattered through it.
 */
export type DeliveryDecision =
  /** Push, then open a pull request. */
  | { readonly outcome: 'delivered' }
  /** Push; the open pull request already proposes the branch. */
  | { readonly outcome: 'updated'; readonly pullRequestUrl: string }
  | { readonly outcome: 'nothing-to-deliver'; readonly reason: string }

export const decideDelivery = (facts: {
  readonly branch: string
  readonly base: string
  /** Commits on the Task Branch that the Base does not have — the branch's
   *  position, not this Run's contribution to it. */
  readonly commitsAhead: number
  readonly openPullRequestUrl?: string
}): DeliveryDecision => {
  // Before the pull request, deliberately: a pull request that proposes nothing
  // is not live work, so the branch's position decides first. Its URL is still
  // named, because "there is an empty pull request open" is more use to whoever
  // reads this than "nothing happened".
  if (facts.commitsAhead === 0) {
    const open = facts.openPullRequestUrl
      ? ` Its open pull request ${facts.openPullRequestUrl} proposes nothing.`
      : ''
    return {
      outcome: 'nothing-to-deliver',
      reason: `${facts.branch} is not ahead of ${facts.base}, so there is nothing to propose.${open}`,
    }
  }
  if (facts.openPullRequestUrl) {
    return { outcome: 'updated', pullRequestUrl: facts.openPullRequestUrl }
  }
  return { outcome: 'delivered' }
}

/**
 * The Delivery a Run that did not complete does not get.
 *
 * Not a `decideDelivery` outcome, and not something `deliver` short-circuits:
 * "the Run did not finish" is a fact about the Run, decided before a Delivery
 * is consulted at all. The Loop's one human gate is a merge, and a pull request
 * from a half-finished Run spends that attention on work nobody claims is done.
 */
export const skippedDelivery = (input: {
  readonly branch: string
  readonly base: string
  readonly reason: string
}): Delivery => ({
  outcome: 'skipped',
  branch: input.branch,
  base: input.base,
  reason:
    `The Run did not complete (${input.reason}), so ${input.branch} was not proposed. ` +
    `Its commits are on that branch; re-dispatch to continue them.`,
})

interface DeliveredTo {
  readonly branch: string
  readonly base: string
}

/** What a Run reports about its Delivery.
 *
 *  Four tags rather than a flag and a URL: a boolean cannot tell "skipped
 *  because the Run did not complete" from "nothing to deliver", which is
 *  precisely the confusion Delivery exists to remove. A pull request URL is
 *  present exactly when one proposes the branch, and a reason exactly when none
 *  does. */
export type Delivery =
  | ({ readonly outcome: 'delivered'; readonly pullRequestUrl: string } & DeliveredTo)
  | ({ readonly outcome: 'updated'; readonly pullRequestUrl: string } & DeliveredTo)
  | ({ readonly outcome: 'nothing-to-deliver'; readonly reason: string } & DeliveredTo)
  | ({ readonly outcome: 'skipped'; readonly reason: string } & DeliveredTo)

export interface DeliveryProvenance {
  /** The Orchestrator's id for this Run. */
  readonly runId: string
  readonly project: string
  /** The Target the Run executed on. */
  readonly target: string
  /** The Run's log — its run page on the Harness, on the Target's loopback,
   *  so a reviewer reaches it through the same tunnel as the dashboard. */
  readonly logs: string
}

export interface DeliveryInput {
  readonly slug: string
  readonly branch: string
  readonly base: string
  /** The commits this Run added, named in a Delivery failure so the work stays
   *  findable. Not what decides the outcome — the branch's position is. */
  readonly commits: readonly string[]
  readonly task: string
  readonly provenance: DeliveryProvenance
}

/** Long enough for a conventional-commit subject, short enough that this repo's
 *  own 100-character header cap survives the ` (#N)` a squash merge appends. */
const TITLE_MAX = 72

/**
 * The pull request's title: the first commit's subject.
 *
 * The agent had to satisfy the Project's own commit conventions to commit at
 * all, so its subject is the one string on hand already known to pass that
 * repository's title lint — which matters wherever a pull request title is
 * linted, as it is here and on the #39 test bed. Truncated task text is a
 * fallback for a branch with no usable subject, not a co-equal option.
 */
export const pullRequestTitle = (subject: string | undefined, task: string): string => {
  const trimmed = (subject ?? '').trim()
  if (trimmed) return trimmed
  const flat = task.replace(/\s+/gu, ' ').trim()
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat
}

/** The pull request's body: what the agent was asked for, verbatim, and what
 *  produced it. A reviewer arriving cold needs both. */
export const pullRequestBody = (input: {
  readonly task: string
  readonly base: string
  readonly provenance: DeliveryProvenance
}): string =>
  [
    input.task.trim(),
    '',
    '---',
    '',
    'Delivered by a sandcastle Run.',
    '',
    `- Run: ${input.provenance.runId}`,
    `- Project: ${input.provenance.project}`,
    `- Target: ${input.provenance.target}`,
    `- Base: ${input.base}`,
    `- Logs: ${input.provenance.logs} — on the Target's loopback, through an SSH tunnel`,
    '',
  ].join('\n')

const pullRequest = z.object({ html_url: z.string().min(1) })
const pullRequests = z.array(pullRequest)

/** The open pull request for this head branch, if there is one. Open only:
 *  Task Branch names are derived from task text and truncated, so name reuse
 *  across time is expected, and reopening a merged pull request would
 *  re-propose commits the Base already has. */
const openPullRequestUrl = async (
  ports: DeliveryPorts,
  slug: string,
  branch: string,
): Promise<string | undefined> => {
  const head = encodeURIComponent(`${slugOwner(slug)}:${branch}`)
  const { status, body } = await ports.github({
    method: 'GET',
    path: `/repos/${slug}/pulls?state=open&head=${head}&per_page=1`,
  })
  if (status !== 200) {
    throw new Error(
      `Could not ask GitHub whether ${branch} already has an open pull request ` +
        `(HTTP ${status})${apiDetail(body)}.`,
    )
  }
  const parsed = pullRequests.safeParse(body)
  if (!parsed.success) {
    throw new Error(`GitHub's answer about ${branch}'s pull requests was not a list of them.`)
  }
  return parsed.data[0]?.html_url
}

/** Open the pull request. Ready rather than draft: the Loop's gate is the merge,
 *  and a draft notifies nobody. */
const createPullRequest = async (
  ports: DeliveryPorts,
  input: DeliveryInput,
  title: string,
): Promise<string> => {
  const { status, body } = await ports.github({
    method: 'POST',
    path: `/repos/${input.slug}/pulls`,
    body: {
      title,
      body: pullRequestBody(input),
      head: input.branch,
      base: input.base,
    },
  })
  if (status !== 201) {
    throw new Error(
      `Could not open a pull request for ${input.branch} against ${input.base} ` +
        `(HTTP ${status})${apiDetail(body)}.`,
    )
  }
  const parsed = pullRequest.safeParse(body)
  if (!parsed.success) {
    throw new Error(`GitHub accepted the pull request for ${input.branch} but did not name it.`)
  }
  return parsed.data.html_url
}

/**
 * How many commits the Task Branch has that its Base does not.
 *
 * Against the remote-tracking ref this Run fetched, which is what "ahead of its
 * Base" means: the question is whether there is anything to propose, not
 * whether this particular Run added to it.
 */
const commitsAhead = async (ports: DeliveryPorts, range: string, base: string): Promise<number> => {
  const counted = await gitOut(
    ports,
    ['rev-list', '--count', range],
    `Counting the Task Branch's commits ahead of ${base}`,
  )
  const ahead = Number.parseInt(counted, 10)
  if (!Number.isInteger(ahead)) {
    throw new Error(`git counted ${range} as "${counted}", which is not a number of commits.`)
  }
  return ahead
}

const firstSubject = async (ports: DeliveryPorts, range: string): Promise<string | undefined> => {
  const subjects = await gitOut(
    ports,
    ['log', '--reverse', '--format=%s', range],
    "Reading the Task Branch's commit subjects",
  )
  return subjects.split('\n')[0]?.trim() || undefined
}

const deliverOnce = async (ports: DeliveryPorts, input: DeliveryInput): Promise<Delivery> => {
  const branchRef = `refs/heads/${input.branch}`
  const range = `refs/remotes/origin/${input.base}..${branchRef}`
  const { branch, base } = input

  const decision = decideDelivery({
    branch,
    base,
    commitsAhead: await commitsAhead(ports, range, base),
    openPullRequestUrl: await openPullRequestUrl(ports, input.slug, branch),
  })
  if (decision.outcome === 'nothing-to-deliver') {
    return { ...decision, branch, base }
  }

  // The refspec is explicit so no `push.default` in the Harness's git config can
  // change what is pushed. No force: a Task Branch that diverged on the remote
  // is a legible failure, never a rewrite of commits already under review.
  await gitOut(ports, ['push', 'origin', `${branchRef}:${branchRef}`], `Pushing ${branch}`)

  if (decision.outcome === 'updated') {
    return { outcome: 'updated', branch, base, pullRequestUrl: decision.pullRequestUrl }
  }
  const title = pullRequestTitle(await firstSubject(ports, range), input.task)
  return {
    outcome: 'delivered',
    branch,
    base,
    pullRequestUrl: await createPullRequest(ports, input, title),
  }
}

/**
 * Attempts, and the pauses between them.
 *
 * The Orchestrator's retry count for a Run is zero and stays that way (ADR
 * 0002): a retried Run would restart the agent and burn subscription usage
 * again. That rationale is about the agent, and it is exactly why Delivery
 * retries *here* instead — a transient push or API failure at this point would
 * otherwise discard twenty minutes of quota-burning work that is already done
 * and committed. Honouring ADR 0002 and retrying the Delivery are the same
 * position, not opposite ones.
 */
const DELIVERY_ATTEMPTS = 3
export const DELIVERY_BACKOFF_MS: readonly number[] = [2000, 8000]

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Deliver a Run: push its Task Branch and open or update its pull request.
 *
 * Every attempt re-reads the facts before acting, so a retry after a half-
 * completed attempt sees the world as it now is. One consequence is worth
 * naming: if a pull request was created and the response was lost, the retry
 * finds it open and reports `updated` rather than `delivered`. The outcome tag
 * is then off by one word; the pull request, which is what the Loop gates on,
 * is right.
 */
export const deliver = async (
  ports: DeliveryPorts,
  input: DeliveryInput,
  sleep: (ms: number) => Promise<void> = pause,
): Promise<Delivery> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deliverOnce(ports, input)
    } catch (cause) {
      if (attempt >= DELIVERY_ATTEMPTS) {
        throw new Error(
          `Delivery failed for ${input.branch} after ${DELIVERY_ATTEMPTS} attempts: ` +
            `${errorDetail(cause)}\nThe Run's work is not lost: its commits are on ${input.branch} ` +
            `(${input.commits.join(', ') || 'none added by this Run'}), based on ${input.base}. ` +
            `Re-dispatching to the same branch re-attempts the Delivery.`,
          { cause },
        )
      }
      await sleep(DELIVERY_BACKOFF_MS[attempt - 1] ?? 0)
    }
  }
}

/** One line about a Delivery, for a log or a failure message. Either the pull
 *  request it produced or the reason there is none — the same two cases the
 *  outcome discriminates, so there is nowhere for a third to hide. */
export const deliveryNote = (delivery: Delivery): string =>
  delivery.outcome === 'delivered' || delivery.outcome === 'updated'
    ? `${delivery.outcome}: ${delivery.pullRequestUrl}`
    : `${delivery.outcome}: ${delivery.reason}`
