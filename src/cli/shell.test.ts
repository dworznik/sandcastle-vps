import { describe, expect, it } from 'vitest'
import { shellQuote } from './shell.js'

describe('shellQuote', () => {
  it('wraps a plain word so a shell sees exactly it', () => {
    expect(shellQuote('hello')).toBe("'hello'")
  })

  it('protects spaces and shell metacharacters', () => {
    expect(shellQuote('/home/op/my projects; rm -rf /')).toBe("'/home/op/my projects; rm -rf /'")
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'")
  })

  // The one character single quotes cannot protect: close, escape, reopen.
  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })

  it('survives a round trip through a real shell', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const value = 'a\'b "c" $d `e` ;f|g'
    const { stdout } = await promisify(execFile)('bash', ['-c', `printf '%s' ${shellQuote(value)}`])
    expect(stdout).toBe(value)
  })
})
