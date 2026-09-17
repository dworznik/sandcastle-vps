import type { Dirent } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
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

/** A checkout under the workspace root, Onboarded or not. `resolveProject`
 *  answers for one and refuses the rest; this answers for all of them, which
 *  is what a report about a Target needs. */
export interface ProjectSummary extends Project {
  readonly onboarded: boolean
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
 * Every checkout under the workspace root, in name order, with whether it has
 * been Onboarded.
 *
 * Answers rather than throws for a workspace root that is empty or absent: an
 * install writes that root before any Project exists, and this is read by a
 * status report, where "nothing here yet" is a finding and not a failure.
 */
export const listProjects = async (workspaceRoot: string): Promise<ProjectSummary[]> => {
  let entries: Dirent[]
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(workspaceRoot, entry.name)
        // A directory that is not a checkout is something the operator put
        // there. Listing it as a Project would invite a Dispatch that fails
        // for a different reason than the list implied.
        if (!(await exists(join(path, '.git')))) return undefined
        return {
          name: entry.name,
          path,
          imageName: defaultImageName(path),
          onboarded: await exists(join(path, '.sandcastle')),
        }
      }),
  )
  return found
    .filter((project): project is ProjectSummary => project !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))
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
        `Onboard it with "Add a Project" in the creator CLI.`,
    )
  }
  return { name, path, imageName: defaultImageName(path) }
}
