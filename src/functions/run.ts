import { claudeCode, run } from '@ai-hero/sandcastle'
import { docker } from '@ai-hero/sandcastle/sandboxes/docker'
import { agentSandbox } from '../agent.js'
import { taskBranch, validateBranch } from '../branch.js'
import { deliveryPorts, projectSlug, recordBase, resolveBase } from '../delivery.js'
import { env } from '../env.js'
import { ensureSandboxImage } from '../image.js'
import { inngest, runRequested } from '../inngest.js'
import { resolveProject } from '../projects.js'

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
  async ({ event, logger }) => {
    const project = await resolveProject(env.workspaceRoot, event.data.project)
    const branch = event.data.branch
      ? validateBranch(event.data.branch)
      : taskBranch(event.data.task)
    const model = event.data.model ?? env.defaultModel
    const { imageName } = project

    // Before the image build, which can take half an hour: a Run that is going
    // to fail for want of a credential should fail in the first second. The
    // Base is resolved here for the same reason, and because a Dispatch naming
    // a Base that conflicts with the Task Branch's is refused rather than run.
    const agent = agentSandbox(env.credentials)
    const ports = deliveryPorts(project.path, agent.credentials.githubToken)
    const slug = await projectSlug(ports)
    const { base, startPoint } = await resolveBase(ports, {
      slug,
      branch,
      requested: event.data.base,
    })

    const { built } = await ensureSandboxImage(project)
    logger.info('starting run', {
      project: project.name,
      branch,
      base,
      model,
      imageName,
      builtImage: built,
    })

    const result = await run({
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
        path: `${project.path}/.sandcastle/logs/${branch.replaceAll('/', '-')}.log`,
        onAgentStreamEvent: (streamEvent) => {
          if (streamEvent.type === 'text') {
            logger.info(streamEvent.message)
          } else if (streamEvent.type === 'toolCall') {
            logger.info(`[tool] ${streamEvent.name} ${streamEvent.formattedArgs}`)
          }
        },
      },
    })

    // The branch exists now, so the Base it was cut from can be recorded
    // against it — which is what lets a re-dispatch continue this Task Branch
    // without re-resolving, and what makes a conflicting Base refusable.
    await recordBase(ports, result.branch, base)

    return {
      project: project.name,
      branch: result.branch,
      base,
      commits: result.commits.map((c) => c.sha),
      completionSignal: result.completionSignal,
      logFilePath: result.logFilePath,
      preservedWorktreePath: result.preservedWorktreePath,
      usage: result.iterations.at(-1)?.usage,
    }
  },
)
