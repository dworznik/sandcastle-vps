import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** The root of this package — the directory holding its package.json. */
export const packageRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const packageVersion = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(packageRoot(), 'package.json'), 'utf8'))
  return String(manifest.version)
}

/**
 * Pack this package the way npm would publish it, and hand back the tarball.
 *
 * The package *is* the Harness (ADR 0006): what the Target runs is whatever
 * the operator invoked, so the delivered contents have to be the CLI's own —
 * not a clone, not a published image, and not a hand-rolled file list that
 * could drift from `files` in package.json. `npm pack` applies exactly the
 * rules npm publish would, in both places this runs from: a checkout during
 * development, and an already-extracted package under npx.
 */
export const packSelf = async (): Promise<{
  readonly tarball: string
  readonly cleanup: () => Promise<void>
}> => {
  const destination = await mkdtemp(join(tmpdir(), 'sandcastle-vps-pack-'))
  const cleanup = () => rm(destination, { recursive: true, force: true })
  try {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', destination], {
      cwd: packageRoot(),
      maxBuffer: 8 * 1024 * 1024,
    })
    const [packed] = JSON.parse(stdout)
    if (!packed?.filename) throw new Error(`npm pack reported no tarball: ${stdout}`)
    return { tarball: join(destination, packed.filename), cleanup }
  } catch (cause) {
    await cleanup()
    throw new Error(
      `Could not pack this package for delivery: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}
