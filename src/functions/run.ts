import { hostname } from 'node:os'
import { join } from 'node:path'
import { claudeCode, run, type RunResult } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'
import type { Logger } from 'inngest'
import type { z } from 'zod'
import { agentSandbox } from '../agent.js'
import { taskBranch, validateBranch } from '../branch.js'
import {
  deliver,
  deliveryNote,
  skippedDelivery,
  projectSlug,
  recordBase,
  resolveBase,
} from '../delivery.js'
import { env, secretValues } from '../env.js'
import { deliveryPorts } from '../delivery-ports.js'
import { errorDetail } from '../errors.js'
import { ensureSandboxImage } from '../image.js'
import { inngest, runRequested, type runRequestedData } from '../inngest.js'
import { resolveProject, type Project } from '../projects.js'
import { openRunLog, type RunLog } from '../run-logs/run-dir.js'

export const sandcastleRun = inngest.createFunction(
  {
    id: 'sandcastle-run',
    // A Run is one long opaque step: a retry would restart the whole agent
    // run and silently burn subscription usage. See ADR 0002.
    retries: 0,
    // Serialize Runs per Project to protect the shared checkout's git state.
    concurrency: { key: 'event.data.project', limit: 1 },
    triggers: runRequested,
  },
  async ({ event, logger, runId }) => {
    const project = await resolveProject(env.workspaceRoot, event.data.project)

    // The run directory, before anything else that can fail: a Run that dies
    // in its first second still has a place that says so. Keyed by the id the
    // Dispatch answered with, so the link handed out then points here.
    const log = await openRunLog({
      projectPath: project.path,
      id: event.id ?? runId,
      runId,
      port: env.port,
      secrets: secretValues(env.credentials),
    })
    try {
      return await execute({ event, logger, runId }, project, log)
    } catch (cause) {
      const error = errorDetail(cause)
      log.harness('run.failed', { error, duration_ms: Date.now() - log.openedAt })
      // A thrown Run has no result to carry the link, so its message does.
      throw new Error(`${error}\n\nRun logs: ${log.url}`, { cause })
    } finally {
      await log.close()
    }
  },
)

/** What of the function's context the Run reads. */
interface RunContext {
  readonly event: { readonly data: z.infer<typeof runRequestedData> }
  readonly logger: Logger
  /** The Orchestrator's id for this invocation of the function. */
  readonly runId: string
}

const execute = async ({ event, logger, runId }: RunContext, project: Project, log: RunLog) => {
  const branch = event.data.branch ? validateBranch(event.data.branch) : taskBranch(event.data.task)
  const model = event.data.model ?? env.defaultModel
  const { imageName } = project
  log.harness('run.started', {
    run_id: runId,
    project: project.name,
    branch,
    model,
    task: event.data.task,
  })

  // Before the image build, which can take half an hour: a Run that is going
  // to fail for want of a credential should fail in the first second. The
  // Base is resolved here for the same reason, and because a Dispatch naming
  // a Base that conflicts with the Task Branch's is refused rather than run.
  const agent = agentSandbox(env.credentials, { hooksFile: log.hooksFile })
  const ports = deliveryPorts(project.path, agent.credentials.githubToken)
  const slug = await projectSlug(ports)
  const { base, startPoint } = await resolveBase(ports, {
    slug,
    branch,
    requested: event.data.base,
  })
  log.harness('base.resolved', { base, start_point: startPoint })
  // Recorded before the Run, not after it: sandcastle creates the Task Branch
  // when it creates the worktree, which is before the agent starts. A Run that
  // then fails leaves a real branch behind, and a branch with no recorded Base
  // is one a later Dispatch could silently re-point — sandcastle ignores
  // `baseBranch` for an existing branch, so the work would continue from the
  // old start point while its pull request proposed it against a new Base.
  //
  // The cost is a recorded Base for a branch that was never cut, in the narrow
  // case of a Run failing before its worktree exists. That makes a later
  // Dispatch naming a different Base refuse and say to use a new branch, which
  // is the conservative direction to be wrong in.
  await recordBase(ports, branch, base)

  const { built } = await ensureSandboxImage(project)
  log.harness('image.ready', { image: imageName, built })
  logger.info('starting run', {
    project: project.name,
    branch,
    base,
    model,
    imageName,
    builtImage: built,
    logs: log.url,
  })

  const provenance = {
    runId,
    project: project.name,
    // The Harness is a container (ADR 0006), so this is the name the Target's
    // engine gave it — the only identifier for the Target available in this
    // process. Good enough to tell two Targets' pull requests apart, which is
    // all a reviewer needs it for.
    target: hostname(),
    logs: log.url,
  }

  /** Everything a Delivery of this Run needs that is known before it runs. */
  const delivering = { slug, branch, base, task: event.data.task }

  log.harness('agent.started', { model })
  log.watchHooks()
  const agentStartedAt = Date.now()
  let result: RunResult
  try {
    result = await run({
      cwd: project.path,
      prompt: event.data.task,
      agent: claudeCode(model),
      // The credentials are the Harness's and last one Run (ADR 0006). They
      // ride the sandbox provider because that is what puts them on the
      // container itself, where the git-setup hook below can read them too —
      // and because provider env wins over anything a Project happens to have
      // left in a `.sandcastle/.env`, which is no longer written or needed.
      sandbox: docker({ imageName, env: agent.env, mounts: agent.mounts }),
      hooks: agent.hooks,
      // Task Branch only — head/merge-to-head are forbidden on shared
      // checkouts. See ADR 0001.
      //
      // `baseBranch` is the freshly fetched remote-tracking ref, so a new Task
      // Branch is cut from the Base and not from whatever branch the shared
      // checkout is sitting on. sandcastle ignores it for a branch that already
      // exists, which is exactly the wanted behaviour on a re-dispatch: the
      // Task Branch continues rather than being rebased.
      branchStrategy: { type: 'branch', branch, baseBranch: startPoint },
      name: `${project.name}:${branch}`,
      logging: {
        type: 'file',
        // In the run directory rather than under `.sandcastle/logs/` by branch
        // name, where a re-dispatch to the same Task Branch overwrote it.
        path: join(log.dir, 'sandcastle.log'),
        onAgentStreamEvent: (streamEvent) => {
          if (streamEvent.type === 'raw') {
            // The verbatim stream, kept beside the reduced events: sandcastle's
            // own log renders it rather than storing it, and a reducer is only
            // as good as the raw lines one can check it against.
            log.stream(streamEvent.line)
          } else if (streamEvent.type === 'text') {
            logger.info(streamEvent.message)
          } else if (streamEvent.type === 'toolCall') {
            logger.info(`[tool] ${streamEvent.name} ${streamEvent.formattedArgs}`)
          }
        },
      },
    })
  } catch (cause) {
    // A Run that failed does not Deliver: no push, no pull request, and
    // nothing asked of git or GitHub. Said in the failure, so the absent pull
    // request reads as a consequence of this failure rather than as a second
    // one.
    const skipped = skippedDelivery({ branch, base, reason: errorDetail(cause) })
    throw new Error(`${errorDetail(cause)}\n\nNot Delivered — ${deliveryNote(skipped)}`, {
      cause,
    })
  }
  // The SessionEnd hook has fired by now; drain what it wrote before the
  // Harness's own events go on after it.
  await log.close()

  // The captured transcript lands under this container's home, which is not a
  // volume. The copy in the run directory is the one that outlives the
  // container — and a Run whose transcript could not be copied is still a Run
  // that finished, so this is reported rather than thrown.
  for (const iteration of result.iterations) {
    if (!iteration.sessionFilePath) continue
    try {
      await log.captureSession(iteration.sessionFilePath)
    } catch (cause) {
      logger.warn('session transcript not captured', { path: iteration.sessionFilePath, cause })
      log.harness('session.capture_failed', {
        path: iteration.sessionFilePath,
        error: errorDetail(cause),
      })
    }
  }
  log.harness('agent.finished', {
    commits: result.commits.map((c) => c.sha),
    completion_signal: result.completionSignal,
    duration_ms: Date.now() - agentStartedAt,
  })

  // Everything after this — the recorded Base, the push, the pull request's
  // head — is keyed on the branch name the Base was resolved for. sandcastle
  // echoes back the branch it actually worked on, and for the `branch` strategy
  // that is the same name; if the two ever disagreed, a Delivery would propose
  // a branch nobody planned, so disagreeing is a failure rather than something
  // to quietly reconcile.
  if (result.branch !== branch) {
    throw new Error(
      `The Run asked for Task Branch ${branch} and sandcastle worked on ${result.branch}. ` +
        `Its commits are on ${result.branch}; nothing was Delivered, because the Base was ` +
        `resolved for ${branch}.`,
    )
  }

  // Delivery is part of the Run, not a later phase and not a second function:
  // the Run's result has to carry the pull request URL, and only something
  // inside the Run can put it there.
  //
  // It is deliberately *not* an Inngest step, which is what #70's brief asked
  // for. A function with a step is re-invoked once that step completes, with
  // the step replayed from memoised state and everything outside a step run
  // again — and the agent run above is outside one. A Delivery step would
  // therefore restart the agent, which is the exact outcome ADR 0002 sets
  // retries to zero to prevent. Wrapping the agent in a step instead is a
  // separate ticket and its own set of problems (a RunResult carrying full
  // stdout, against a step-output size limit). See ADR 0008.
  const delivery = await deliver(ports, {
    ...delivering,
    commits: result.commits.map((c) => c.sha),
    provenance,
  })
  logger.info(`delivery ${deliveryNote(delivery)}`)
  log.harness('delivery.finished', {
    outcome: delivery.outcome,
    ...('pullRequestUrl' in delivery ? { pull_request_url: delivery.pullRequestUrl } : {}),
    ...('reason' in delivery ? { reason: delivery.reason } : {}),
  })
  log.harness('run.finished', { duration_ms: Date.now() - log.openedAt })

  return {
    project: project.name,
    branch,
    base,
    commits: result.commits.map((c) => c.sha),
    completionSignal: result.completionSignal,
    preservedWorktreePath: result.preservedWorktreePath,
    usage: result.iterations.at(-1)?.usage,
    delivery,
    // The link the Orchestrator's run page shows, and where the files are on
    // the Target. The tail is the last of `events.jsonl`, capped, so a glance
    // at the result says how the Run ended without opening the page.
    logs: { url: log.url, dir: log.dir },
    tail: await log.tail(),
  }
}
