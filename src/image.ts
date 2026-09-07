import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Project } from './projects.js'

const exec = promisify(execFile)

/** Image builds install a toolchain from scratch; give them room. */
const BUILD_TIMEOUT_MS = 30 * 60 * 1000
const BUILD_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/** The two docker-facing effects, isolated so the build-once rule is testable. */
export interface ImageTools {
  readonly imageExists: (imageName: string) => Promise<boolean>
  readonly buildImage: (project: Project) => Promise<void>
}

/**
 * The sandcastle CLI this harness itself depends on, so a Run builds with the
 * same version it orchestrates with rather than whatever `npx` resolves to.
 */
const sandcastleCli = (): string =>
  join(dirname(fileURLToPath(import.meta.resolve('@ai-hero/sandcastle'))), 'main.js')

const errorDetail = (error: unknown): string => {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr).trim()
    if (stderr) return stderr
  }
  return error instanceof Error ? error.message : String(error)
}

export const dockerImageTools: ImageTools = {
  imageExists: async (imageName) => {
    try {
      await exec('docker', ['image', 'inspect', imageName])
      return true
    } catch {
      return false
    }
  },
  /**
   * The documented onboarding build command, run in the Project's own
   * directory — image name and Dockerfile both come from sandcastle's
   * conventions there, so this repo never restates them.
   */
  buildImage: async (project) => {
    await exec(process.execPath, [sandcastleCli(), 'docker', 'build-image'], {
      cwd: project.path,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: BUILD_MAX_OUTPUT_BYTES,
    })
  },
}

/**
 * Make sure the Project's image is present before a Run.
 *
 * A queued Run shouldn't die just because a Project was cloned but never
 * built, so a missing image is built once. An existing image is never
 * rebuilt: Dockerfile edits are followed by a manual rebuild, so that a Run
 * can't silently pick up a half-finished image change (ADR 0003).
 */
export const ensureSandboxImage = async (
  project: Project,
  tools: ImageTools = dockerImageTools,
): Promise<{ readonly built: boolean }> => {
  if (await tools.imageExists(project.imageName)) {
    return { built: false }
  }
  try {
    await tools.buildImage(project)
  } catch (cause) {
    throw new Error(
      `Failed to build image ${project.imageName} for Project "${project.name}": ${errorDetail(cause)}`,
      { cause },
    )
  }
  return { built: true }
}
