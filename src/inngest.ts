import { Inngest, eventType } from 'inngest'
import { z } from 'zod'
import { APP_ID } from './app-id.js'

export const runRequestedData = z.object({
  /** Directory name of a Project under the workspace root. */
  project: z.string().min(1),
  /** Task description handed to the agent as its prompt. */
  task: z.string().min(1),
  /** Task Branch name; derived from the task text when omitted.
   *  Re-dispatching to an existing branch resumes its worktree. */
  branch: z.string().min(1).optional(),
  /** The Base: the branch the Task Branch is cut from and its pull request is
   *  proposed against. Defaults to the Project remote's default branch. Ignored
   *  on a re-dispatch when it matches the Task Branch's recorded Base, and
   *  rejected when it conflicts with it. */
  base: z.string().min(1).optional(),
  /** Agent model override. */
  model: z.string().min(1).optional(),
})

export const runRequested = eventType('sandcastle/run.requested', {
  schema: runRequestedData,
})

export const inngest = new Inngest({ id: APP_ID })
