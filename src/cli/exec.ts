/**
 * One shape for "a command on the Target did not work", so every flow that
 * reads an `exec` result reports a failure the same way. Its own module, and
 * a small one, because both the install and what the install runs — the
 * Access service — need it, and one importing it from the other is a cycle.
 */
export const fail = (what: string, code: number, stderr: string): Error =>
  new Error(`${what} failed (exit ${code}): ${stderr.trim().split('\n').at(-1) ?? 'no output'}`)
