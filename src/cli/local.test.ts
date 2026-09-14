import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localShell, onPath, openCommand } from './local.js'

describe('onPath', () => {
  it('finds an executable on the path it was given, and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandcastle-path-'))
    await writeFile(join(dir, 'pretend-claude'), '#!/bin/sh\n')
    await chmod(join(dir, 'pretend-claude'), 0o755)

    expect(await onPath('pretend-claude', dir)).toBe(true)
    expect(await onPath('pretend-gh', dir)).toBe(false)
  })

  // A file that is there but not executable is not a command, and reporting it
  // as one sends the flow down a branch that then fails to spawn.
  it('ignores a file it could not run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandcastle-path-'))
    await writeFile(join(dir, 'not-a-command'), 'text')
    await chmod(join(dir, 'not-a-command'), 0o644)

    expect(await onPath('not-a-command', dir)).toBe(false)
  })

  it('walks every entry, not only the first', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sandcastle-path-'))
    const dir = await mkdtemp(join(tmpdir(), 'sandcastle-path-'))
    await writeFile(join(dir, 'pretend-gh'), '#!/bin/sh\n')
    await chmod(join(dir, 'pretend-gh'), 0o755)

    expect(await onPath('pretend-gh', [empty, dir].join(delimiter))).toBe(true)
  })

  it('answers for an empty path rather than throwing', async () => {
    expect(await onPath('anything', '')).toBe(false)
  })
})

describe('openCommand', () => {
  it('uses the opener each platform actually has', () => {
    expect(openCommand('https://example.com', 'darwin')).toEqual(['open', ['https://example.com']])
    expect(openCommand('https://example.com', 'linux')).toEqual([
      'xdg-open',
      ['https://example.com'],
    ])
    expect(openCommand('https://example.com', 'win32')[0]).toBe('cmd')
  })
})

describe('localShell', () => {
  // Every caller has something useful to say about a command that is not
  // there; none of them can say anything about an exception thrown out of a
  // spawn, halfway through capturing credentials.
  it('reports a command that does not exist rather than throwing', async () => {
    const result = await localShell().run('definitely-not-a-command-8f3a', [])
    expect(result.code).not.toBe(0)
  })

  it('collects what a command printed', async () => {
    const { code, stdout } = await localShell().run('printf', ['hello'])
    expect({ code, stdout }).toEqual({ code: 0, stdout: 'hello' })
  })

  // Non-zero is an answer, not a failure — the same contract a Connector's
  // `exec` has, so `git config --get` on a machine with no identity set is
  // read as "no default" rather than crashing the wizard.
  it('does not throw for a non-zero exit', async () => {
    const { code } = await localShell().run('sh', ['-c', 'exit 3'])
    expect(code).toBe(3)
  })
})
