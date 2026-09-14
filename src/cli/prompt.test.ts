import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createPrompter } from './prompt.js'

/** A prompter wired to streams a test can drive, the way the CLI wires it to
 *  the terminal. `tty` is what decides whether readline echoes what is typed,
 *  so the muting a secret depends on only exists when it is set. */
const harness = ({ tty = false }: { tty?: boolean } = {}) => {
  const input = Object.assign(new PassThrough(), { isTTY: tty })
  const output = Object.assign(new PassThrough(), { isTTY: tty })
  let written = ''
  output.on('data', (chunk: Buffer) => (written += chunk.toString()))
  return {
    prompter: createPrompter(input, output),
    answer: (...lines: string[]) => input.write(lines.map((line) => `${line}\n`).join('')),
    type: (keys: string) => input.write(keys),
    end: () => input.end(),
    get shown() {
      return written
    },
  }
}

describe('createPrompter', () => {
  it('takes an answer typed after the question', async () => {
    const { prompter, answer } = harness()
    const asked = prompter.text('Name')
    answer('vps')
    expect(await asked).toBe('vps')
    prompter.close()
  })

  // Piped input reaches EOF long before the last question is asked. A reader
  // that only listened while a question was pending would drop every answer
  // that had already arrived — which is exactly how this first behaved.
  it('answers questions from input that arrived all at once, and ended', async () => {
    const { prompter, answer, end } = harness()
    answer('vps', '2', 'yes')
    end()
    expect(await prompter.text('Name')).toBe('vps')
    expect(
      await prompter.select('Pick', [
        { label: 'a', value: 'a' },
        { label: 'b', value: 'b' },
      ]),
    ).toBe('b')
    expect(await prompter.confirm('Sure?')).toBe(true)
    prompter.close()
  })

  it('falls back when the operator just presses enter', async () => {
    const { prompter, answer } = harness()
    const asked = prompter.text('Where', '/home/op/work')
    answer('')
    expect(await asked).toBe('/home/op/work')
    prompter.close()
  })

  it('re-asks rather than guessing at an answer it cannot read', async () => {
    // Not destructured: `shown` is a getter, and pulling it out would snapshot
    // an empty string before anything was written.
    const cli = harness()
    const asked = cli.prompter.select('Pick', [{ label: 'a', value: 'a' }])
    cli.answer('7', '1')
    expect(await asked).toBe('a')
    cli.prompter.close()
    expect(cli.shown).toContain('Pick a number between 1 and 1')
  })

  it("takes a confirmation's default from the shape of the question", async () => {
    const { prompter, answer } = harness()
    const yes = prompter.confirm('Run it?', true)
    answer('')
    expect(await yes).toBe(true)
    const no = prompter.confirm('Run it?')
    answer('')
    expect(await no).toBe(false)
    prompter.close()
  })

  // A secret that reaches the terminal reaches the scrollback, the screen
  // share, and whatever is recording the session. This is the whole reason
  // `secret` exists rather than `text` being reused for a token.
  it('keeps a typed secret off the terminal', async () => {
    const cli = harness({ tty: true })
    const asked = cli.prompter.secret('Paste the token')
    cli.type('sk-ant-oat01-notreal\r')
    expect(await asked).toBe('sk-ant-oat01-notreal')
    cli.prompter.close()
    expect(cli.shown).toContain('Paste the token')
    expect(cli.shown).not.toContain('sk-ant-oat01-notreal')
  })

  // The companion to the test above, and the reason it proves anything: the
  // stream readline echoes to is this module's own, and a mistake in it would
  // silence every prompt rather than only the secret — passing the muting test
  // for the wrong reason.
  it('still echoes a typed ordinary answer', async () => {
    const cli = harness({ tty: true })
    const asked = cli.prompter.text('Name')
    cli.type('vps\r')
    expect(await asked).toBe('vps')
    cli.prompter.close()
    expect(cli.shown).toContain('vps')
  })

  // Piped input is echoed by the wizard itself, because it never appeared on
  // the terminal by itself — and that echo is exactly what must not happen
  // here. This is a different code path from the typed one above.
  it('keeps a piped secret off the terminal too', async () => {
    const cli = harness()
    cli.answer('sk-ant-oat01-notreal')
    cli.end()
    expect(await cli.prompter.secret('Paste the token')).toBe('sk-ant-oat01-notreal')
    cli.prompter.close()
    expect(cli.shown).not.toContain('sk-ant-oat01-notreal')
  })

  it('still echoes an ordinary answer, so a piped session reads as a transcript', async () => {
    const cli = harness()
    cli.answer('vps')
    cli.end()
    expect(await cli.prompter.text('Name')).toBe('vps')
    cli.prompter.close()
    expect(cli.shown).toContain('vps')
  })

  it('re-asks rather than accepting an empty secret', async () => {
    const cli = harness()
    const asked = cli.prompter.secret('Paste the token')
    cli.answer('', 'sk-ant-oat01-notreal')
    expect(await asked).toBe('sk-ant-oat01-notreal')
    cli.prompter.close()
    expect(cli.shown).toContain('An answer is needed')
  })

  // Input that runs out mid-question would otherwise hang the wizard forever.
  it('gives up when the input ends with a question outstanding', async () => {
    const { prompter, end } = harness()
    const asked = prompter.text('Name')
    end()
    await expect(asked).rejects.toThrow(/Input ended/)
    prompter.close()
  })
})
