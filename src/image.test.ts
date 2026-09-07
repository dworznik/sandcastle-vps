import { describe, expect, it, vi } from 'vitest'
import { ensureSandboxImage, type ImageTools } from './image.js'
import type { Project } from './projects.js'

const project: Project = {
  name: 'my-app',
  path: '/workspace/my-app',
  imageName: 'sandcastle:my-app',
}

const tools = (overrides: Partial<ImageTools> = {}): ImageTools => ({
  imageExists: vi.fn(async () => true),
  buildImage: vi.fn(async () => {}),
  ...overrides,
})

describe('ensureSandboxImage', () => {
  it("builds the Project's image exactly once when it is missing", async () => {
    const deps = tools({ imageExists: vi.fn(async () => false) })

    const result = await ensureSandboxImage(project, deps)

    expect(result).toEqual({ built: true })
    expect(deps.buildImage).toHaveBeenCalledExactlyOnceWith(project)
  })

  it('never rebuilds an image that already exists', async () => {
    const deps = tools({ imageExists: vi.fn(async () => true) })

    const result = await ensureSandboxImage(project, deps)

    expect(result).toEqual({ built: false })
    expect(deps.buildImage).not.toHaveBeenCalled()
  })

  it("checks for the Project's own image, not a shared one", async () => {
    const deps = tools()

    await ensureSandboxImage(project, deps)

    expect(deps.imageExists).toHaveBeenCalledExactlyOnceWith('sandcastle:my-app')
  })

  it('fails with the Project and image named when the build fails', async () => {
    const deps = tools({
      imageExists: vi.fn(async () => false),
      buildImage: vi.fn(async () => {
        throw new Error('dockerfile line 3 exploded')
      }),
    })

    await expect(ensureSandboxImage(project, deps)).rejects.toThrow(
      /Failed to build image sandcastle:my-app for Project "my-app"[\s\S]*dockerfile line 3 exploded/,
    )
  })
})
