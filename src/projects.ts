import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker'

export interface Project {
  readonly name: string
  /** Absolute host path to the Project checkout. */
  readonly path: string
  /** The Project's own image, by sandcastle's `sandcastle:<dir-name>`
   *  convention. There is no shared fallback image — see ADR 0003. */
  readonly imageName: string
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a Project by convention: `name` is a directory under the workspace
 * root holding a checkout that has been Onboarded. Names are plain directory
 * names — anything that would traverse out of the workspace root is rejected.
 *
 * A checkout that was never Onboarded is an error, not a fallback to a default
 * image: a Project owns its sandbox definition and its credentials (ADR 0003).
 */
export const resolveProject = async (workspaceRoot: string, name: string): Promise<Project> => {
  if (!name || name !== basename(name) || name === '.' || name === '..') {
    throw new Error(`Invalid project name: ${name}`)
  }
  const path = join(workspaceRoot, name)
  if (!(await exists(join(path, '.git')))) {
    throw new Error(`Project "${name}" is not a git checkout under ${workspaceRoot}`)
  }
  if (!(await exists(join(path, '.sandcastle')))) {
    throw new Error(
      `Project "${name}" has not been Onboarded: ${path} has no .sandcastle/ directory. ` +
        `Onboard it first with: init-project ${name}`,
    )
  }
  return { name, path, imageName: defaultImageName(path) }
}
