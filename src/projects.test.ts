import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveProject } from './projects.js'

describe('resolveProject', () => {
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
      /has not been Onboarded[\s\S]*init-project bare-checkout/,
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
