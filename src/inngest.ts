import { Inngest, eventType } from 'inngest'
import { z } from 'zod'

export const runRequestedData = z.object({
  /** Directory name of a Project under the workspace root. */
  project: z.string().min(1),
  /** Task description handed to the agent as its prompt. */
  task: z.string().min(1),
  /** Task Branch name; derived from the task text when omitted.
   *  Re-dispatching to an existing branch resumes its worktree. */
  branch: z.string().min(1).optional(),
  /** Agent model override. */
  model: z.string().min(1).optional(),
})

export const runRequested = eventType('sandcastle/run.requested', {
  schema: runRequestedData,
})

export const inngest = new Inngest({ id: 'sandcastle-vps' })
