import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { ExecResult } from './connectors/types.js'

/**
 * The operator's own machine — the other side of a Connector.
 *
 * A Connector reaches the Target; this reaches the machine the wizard is being
 * run on, which credential capture needs for three things a Target cannot do:
 * run the operator's `claude` login, read their git identity, and open a
 * browser at a GitHub page. It is an interface for the same reason a Connector
 * is one — so the flow can be driven in a test without a terminal, a browser,
 * or an Anthropic account.
 *
 * Nothing here takes a secret as an argument. A process's arguments are
 * readable by every other process on the machine, so credentials travel on
 * stdin, in an environment, or not at all.
 */
export interface LocalShell {
  /** Is this on the operator's PATH? Answered by looking, not by running: a
   *  presence check that executes the thing it is checking for has side
   *  effects, and `claude` is a program with a login flow in it. */
  has(command: string): Promise<boolean>
  /** Run and collect. Never throws for a non-zero exit — the caller decides
   *  what a failure means, as with a Connector. */
  run(command: string, args: readonly string[]): Promise<ExecResult>
  /**
   * Run with the operator's terminal attached, capturing only stdout.
   *
   * `claude setup-token` is a conversation — it prints a URL, waits for the
   * browser, and prints the token at the end. Its prompts go to stderr and the
   * terminal it inherits; the token goes to stdout, which is why the retired
   * host path could write `claude setup-token | init-project`.
   */
  interactive(command: string, args: readonly string[]): Promise<ExecResult>
  /** Show the operator a page. Best-effort by design: a dev machine reached
   *  over ssh has no browser, and the URL is printed either way. */
  open(url: string): Promise<void>
}

/**
 * Look for an executable along PATH.
 *
 * POSIX only — an extensionless name and `:` as the separator. Windows dev
 * machines are out of scope for the creator CLI (#26), and a half-correct
 * PATHEXT search would be a worse answer than not pretending to support it.
 */
export const onPath = async (command: string, path = process.env.PATH ?? ''): Promise<boolean> => {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(dir, command), constants.X_OK)
      return true
    } catch {
      // Not here, or not executable. Both mean "keep looking".
    }
  }
  return false
}

/** The opener for this platform, and its arguments. */
export const openCommand = (url: string, platform = process.platform): [string, string[]] => {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]]
  return ['xdg-open', [url]]
}

const collect = (
  command: string,
  args: readonly string[],
  stdio: 'pipe' | 'inherit',
): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      // stdin and stderr are the operator's when the command is a
      // conversation; stdout is captured in both modes, because it is what the
      // caller came for.
      stdio: [stdio, 'pipe', stdio],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => (stderr += chunk))
    // A command that is not installed is an answer, not a crash: `has` is the
    // usual guard, and every caller here has a path for "it did not work".
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })

export const localShell = (): LocalShell => ({
  has: (command) => onPath(command),
  run: (command, args) => collect(command, args, 'pipe'),
  interactive: (command, args) => collect(command, args, 'inherit'),
  open: async (url) => {
    const [command, args] = openCommand(url)
    if (!(await onPath(command))) return
    // Detached and disowned: a browser outliving the wizard is the point, and
    // a handle on it would keep Node's event loop alive after the CLI is done.
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  },
})
