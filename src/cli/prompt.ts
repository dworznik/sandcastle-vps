import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'

export interface Choice<T> {
  readonly label: string
  readonly value: T
}

export interface Prompter {
  text(question: string, fallback?: string): Promise<string>
  /** A question whose answer is a secret: never echoed, and never defaulted —
   *  there is no sensible fallback for a credential. */
  secret(question: string): Promise<string>
  select<T>(question: string, choices: readonly Choice<T>[]): Promise<T>
  /** Pick any number of them, including none. For rotation, where the
   *  question is "which of these" rather than "which one". */
  multi<T>(question: string, choices: readonly Choice<T>[]): Promise<T[]>
  confirm(question: string, fallback?: boolean): Promise<boolean>
  /**
   * Run something that needs the terminal to itself — an attached Session —
   * with this prompter's reading of stdin stopped for the duration. Readline
   * otherwise keeps reading the same terminal the child is reading, and
   * every other keystroke would land here instead of in tmux.
   */
  suspended<T>(work: () => Promise<T>): Promise<T>
  close(): void
}

/**
 * Read a choice of several: numbers in any of the ways someone might separate
 * them, `all` for every one, and an empty line for none.
 *
 * Returns `undefined` for anything it cannot read completely, so the caller
 * re-asks — a partial reading of "1, 4" on a list of three would rotate one
 * credential while the operator believed they had asked for two.
 */
export const readChoices = (answer: string, count: number): number[] | undefined => {
  const trimmed = answer.trim().toLowerCase()
  if (!trimmed) return []
  if (trimmed === 'all') return Array.from({ length: count }, (_, index) => index)
  const picked = trimmed.split(/[\s,]+/u).filter(Boolean)
  const indexes = picked.map((one) => Number(one) - 1)
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    return undefined
  }
  return [...new Set(indexes)].sort((a, b) => a - b)
}

type Output = NodeJS.WritableStream & { isTTY?: boolean; columns?: number }

/**
 * The wizard's questions, including the ones whose answers are credentials.
 *
 * Hiding an answer means stopping readline from echoing it, and readline
 * echoes to whatever stream it was handed — so it is handed a stream this
 * module can switch off rather than the terminal itself. The alternative,
 * reaching into `rl._writeToOutput`, is the same idea through a private field.
 */
export const createPrompter = (
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: Output = process.stdout,
): Prompter => {
  // Everything readline writes passes through here; everything this module
  // writes goes straight to `output`, so a question is still printed while the
  // answer to it is being swallowed.
  let muted = false
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) output.write(chunk)
      done()
    },
  })
  // readline asks its output whether it is a terminal — that is what decides
  // whether it echoes at all — and how wide the line is. A bare Writable
  // answers neither, which would turn echo off permanently and line editing
  // with it.
  Object.defineProperties(sink, {
    isTTY: { get: () => output.isTTY },
    columns: { get: () => output.columns },
  })

  // No history, because muting only stops the echo. readline otherwise
  // remembers every line it read, and a remembered token is one up-arrow away
  // from the screen at the next question — a worse leak than the echo, because
  // it lands later and in front of someone who has stopped thinking about the
  // token. Recall is worth nothing here anyway: the other answers are a Target
  // name and two paths.
  const rl = createInterface({
    input,
    output: sink,
    terminal: output.isTTY === true,
    historySize: 0,
  })
  const say = (line: string) => output.write(`${line}\n`)

  // Lines are buffered as they arrive rather than pulled one question at a
  // time: piped input reaches EOF long before the last question is asked, and
  // a reader that only listens while a question is pending would drop every
  // answer that had already been read. Typed input behaves the same way, one
  // line at a time.
  const pending: string[] = []
  const waiting: ((line: string | null) => void)[] = []
  let ended = false

  rl.on('line', (line) => {
    const waiter = waiting.shift()
    if (waiter) waiter(line)
    else pending.push(line)
  })
  rl.on('close', () => {
    ended = true
    while (waiting.length > 0) waiting.shift()?.(null)
  })

  const ask = async (query: string, hidden = false): Promise<string> => {
    muted = hidden
    try {
      // On a terminal, a secret is only ever the line typed *after* the
      // question. Anything already buffered arrived while an ordinary question
      // was on screen, so readline echoed it as it was typed — taking it as the
      // answer here would mean accepting a token that is already in the
      // scrollback, silently, as though it had been hidden. A mis-paste is
      // dropped instead, and said so: this is a credential, and guessing which
      // stray line was meant to be it is not a favour.
      if (hidden && input.isTTY && pending.length > 0) {
        pending.length = 0
        say('  (discarding what was typed ahead — a secret is only read after it is asked for)')
      }
      output.write(query)
      const buffered = pending.shift()
      if (buffered !== undefined) {
        // Echo it: a piped answer never appeared on the terminal by itself, and
        // a transcript with questions and no answers is unreadable. A piped
        // secret is the one answer that stays off it anyway — nothing echoed it
        // on the way in, which is why the terminal case above is different.
        if (!input.isTTY && !hidden) say(buffered)
        return buffered.trim()
      }
      if (ended) throw new Error('Input ended before the question was answered.')
      const line = await new Promise<string | null>((resolve) => waiting.push(resolve))
      if (line === null) throw new Error('Input ended before the question was answered.')
      return line.trim()
    } finally {
      if (hidden) {
        muted = false
        // The newline that ended the answer was swallowed with the rest of the
        // echo, so without this the next line lands on the question's.
        output.write('\n')
      }
    }
  }

  const text: Prompter['text'] = async (question, fallback) => {
    for (;;) {
      const answer = await ask(
        fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `,
      )
      if (answer) return answer
      if (fallback !== undefined) return fallback
      say('  An answer is needed.')
    }
  }

  const secret: Prompter['secret'] = async (question) => {
    for (;;) {
      const answer = await ask(`${question}: `, true)
      if (answer) return answer
      say('  An answer is needed. Nothing is echoed — paste it and press enter.')
    }
  }

  const select: Prompter['select'] = async <T>(question: string, choices: readonly Choice<T>[]) => {
    say(`\n${question}`)
    choices.forEach((choice, index) => say(`  ${index + 1}) ${choice.label}`))
    for (;;) {
      const answer = await ask('  > ')
      const choice = choices[Number(answer) - 1]
      if (choice) return choice.value
      say(`  Pick a number between 1 and ${choices.length}.`)
    }
  }

  const multi: Prompter['multi'] = async <T>(question: string, choices: readonly Choice<T>[]) => {
    say(`\n${question}`)
    choices.forEach((choice, index) => say(`  ${index + 1}) ${choice.label}`))
    for (;;) {
      const picked = readChoices(
        await ask('  > numbers, `all`, or enter for none: '),
        choices.length,
      )
      if (picked) return picked.flatMap((index) => (choices[index] ? [choices[index].value] : []))
      say(`  Pick numbers between 1 and ${choices.length}, separated by spaces or commas.`)
    }
  }

  const confirm: Prompter['confirm'] = async (question, fallback = false) => {
    for (;;) {
      const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
      if (!answer) return fallback
      if (['y', 'yes'].includes(answer)) return true
      if (['n', 'no'].includes(answer)) return false
    }
  }

  // `pause` is what stops readline's reads of the input, and it is readline's
  // own — the raw-mode terminal is left as it is, since a child that wants a
  // terminal of its own (ssh -t) sets and restores it itself.
  const suspended: Prompter['suspended'] = async (work) => {
    rl.pause()
    try {
      return await work()
    } finally {
      rl.resume()
    }
  }

  return { text, secret, select, multi, confirm, suspended, close: () => rl.close() }
}
