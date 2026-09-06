import { claudeCode, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { agentSandbox } from "../agent.js";
import { taskBranch, validateBranch } from "../branch.js";
import { env } from "../env.js";
import { ensureSandboxImage } from "../image.js";
import { inngest, runRequested } from "../inngest.js";
import { resolveProject } from "../projects.js";

export const sandcastleRun = inngest.createFunction(
  {
    id: "sandcastle-run",
    // A Run is one long opaque step: a retry would restart the whole agent
    // run and silently burn subscription usage. See ADR 0002.
    retries: 0,
    // Serialize Runs per Project to protect the shared checkout's git state.
    concurrency: { key: "event.data.project", limit: 1 },
    triggers: runRequested,
  },
  async ({ event, logger }) => {
    const project = await resolveProject(env.workspaceRoot, event.data.project);
    const branch = event.data.branch
      ? validateBranch(event.data.branch)
      : taskBranch(event.data.task);
    const model = event.data.model ?? env.defaultModel;
    const { imageName } = project;
    // Identity, signing, and push credentials for the sandbox — all from the
    // Project's own .sandcastle/, none from here.
    const agent = agentSandbox(project);

    const { built } = await ensureSandboxImage(project);
    logger.info("starting run", {
      project: project.name,
      branch,
      model,
      imageName,
      builtImage: built,
    });

    const result = await run({
      cwd: project.path,
      prompt: event.data.task,
      // No credentials from the harness: `cwd` anchors sandcastle's env
      // resolver on the Project's own .sandcastle/.env (ADR 0003).
      agent: claudeCode(model),
      sandbox: docker({ imageName, mounts: agent.mounts }),
      hooks: agent.hooks,
      // Task Branch only — head/merge-to-head are forbidden on shared
      // checkouts. See ADR 0001.
      branchStrategy: { type: "branch", branch },
      name: `${project.name}:${branch}`,
      logging: {
        type: "file",
        path: `${project.path}/.sandcastle/logs/${branch.replaceAll("/", "-")}.log`,
        onAgentStreamEvent: (streamEvent) => {
          if (streamEvent.type === "text") {
            logger.info(streamEvent.message);
          } else if (streamEvent.type === "toolCall") {
            logger.info(`[tool] ${streamEvent.name} ${streamEvent.formattedArgs}`);
          }
        },
      },
    });

    return {
      project: project.name,
      branch: result.branch,
      commits: result.commits.map((c) => c.sha),
      completionSignal: result.completionSignal,
      logFilePath: result.logFilePath,
      preservedWorktreePath: result.preservedWorktreePath,
      usage: result.iterations.at(-1)?.usage,
    };
  },
);
