import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listProjects, resolveProject } from './projects.js'

let workspaceRoot: string

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'sandcastle-vps-test-'))
  await mkdir(join(workspaceRoot, 'my-app', '.git'), { recursive: true })
  await mkdir(join(workspaceRoot, 'my-app', '.sandcastle'), { recursive: true })
  await mkdir(join(workspaceRoot, 'bare-checkout', '.git'), { recursive: true })
  await mkdir(join(workspaceRoot, 'not-a-repo'), { recursive: true })
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

/**
 * What the Harness sees under its workspace root.
 *
 * This is the Harness's own answer, and that is the whole point of asking it:
 * the wizard can see a checkout on the Target's disk over the Connector, but
 * only the Harness can say whether the path-parity mount and `WORKSPACE_ROOT`
 * agree well enough for a Dispatch to resolve it.
 */
describe('listProjects', () => {
  it('reports every checkout, and which of them have been Onboarded', async () => {
    expect(await listProjects(workspaceRoot)).toEqual([
      {
        name: 'bare-checkout',
        path: join(workspaceRoot, 'bare-checkout'),
        imageName: 'sandcastle:bare-checkout',
        onboarded: false,
      },
      {
        name: 'my-app',
        path: join(workspaceRoot, 'my-app'),
        imageName: 'sandcastle:my-app',
        onboarded: true,
      },
    ])
  })

  // A directory that is not a checkout is something the operator put there, not
  // a Project waiting to be Onboarded — listing it would invite Dispatching to
  // it, which fails with a different message entirely.
  it('ignores directories that are not git checkouts', async () => {
    const names = (await listProjects(workspaceRoot)).map((project) => project.name)
    expect(names).not.toContain('not-a-repo')
  })

  // An install writes the workspace root before any Project exists, and a
  // status that threw on an empty Target would be a status that only works
  // once it has nothing useful left to say.
  it('answers for a workspace root that is empty, or is not there at all', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sandcastle-vps-empty-'))
    expect(await listProjects(empty)).toEqual([])
    await rm(empty, { recursive: true, force: true })
    expect(await listProjects(join(workspaceRoot, 'nowhere'))).toEqual([])
  })
})

describe('resolveProject', () => {
  it('resolves an Onboarded checkout to its own sandcastle image', async () => {
    const project = await resolveProject(workspaceRoot, 'my-app')
    expect(project).toEqual({
      name: 'my-app',
      path: join(workspaceRoot, 'my-app'),
      imageName: 'sandcastle:my-app',
    })
  })

  it('rejects a checkout that has never been Onboarded, naming the onboarding step', async () => {
    await expect(resolveProject(workspaceRoot, 'bare-checkout')).rejects.toThrow(
      /has not been Onboarded[\s\S]*Add a Project/,
    )
  })

  it('rejects directories that are not git checkouts', async () => {
    await expect(resolveProject(workspaceRoot, 'not-a-repo')).rejects.toThrow(/not a git checkout/)
  })

  it('rejects a name that does not exist under the workspace root', async () => {
    await expect(resolveProject(workspaceRoot, 'ghost')).rejects.toThrow(/not a git checkout/)
  })

  it('rejects names that traverse out of the workspace root', async () => {
    for (const name of ['../etc', 'a/b', '..', '.', '/abs', '']) {
      await expect(resolveProject(workspaceRoot, name)).rejects.toThrow(/Invalid project name/)
    }
  })
})
