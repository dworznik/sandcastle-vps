/**
 * The Target's compose environment file, edited the way the retired deploy's
 * `env_file_upsert` edited it: one key at a time, leaving every other line
 * byte-for-byte alone. These files are hand-edited and hold credentials, so a
 * rewrite that reformats is a rewrite that loses a comment or a value.
 *
 * This moved off the Target and into the CLI when the install did (#34). The
 * behaviour is unchanged, and deliberately so — `seed` is the whole of what
 * makes a re-run idempotent.
 */

export type UpsertMode =
  /** Fill the key in only if it has no value. An empty `KEY=` — what the
   *  example file scaffolds — counts as having none. */
  | 'seed'
  /** Replace whatever is there. For a credential the operator is rotating. */
  | 'rotate'

/** Does this line set this key? Matched as a literal prefix, never as a
 *  pattern: values and keys both arrive from outside and a regex built from
 *  them would read `.` and `*` as instructions. */
const setsKey = (line: string, key: string): boolean => line.startsWith(`${key}=`)

const splitLines = (content: string): string[] => {
  if (content === '') return []
  const lines = content.split('\n')
  // A trailing newline is a terminator, not an empty last line — without this
  // every rewrite would grow one.
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export const upsertEnv = (
  content: string,
  key: string,
  value: string,
  mode: UpsertMode,
): string => {
  const line = `${key}=${value}`
  const lines = splitLines(content)
  let found = false
  const rewritten = lines.map((existing) => {
    if (!setsKey(existing, key)) return existing
    found = true
    return mode === 'rotate' || existing === `${key}=` ? line : existing
  })
  if (!found) rewritten.push(line)
  return `${rewritten.join('\n')}\n`
}

/** The same, for the several keys an install writes at once. */
export const upsertAllEnv = (
  content: string,
  values: Readonly<Record<string, string>>,
  mode: UpsertMode,
): string =>
  Object.entries(values).reduce(
    (current, [key, value]) => upsertEnv(current, key, value, mode),
    content,
  )

/**
 * What a key is currently set to, or `undefined` when it is absent or empty.
 * Empty and absent are the same answer on purpose: `KEY=` is the scaffolded
 * placeholder, and everything that reads this file treats it as unset.
 */
export const readEnv = (content: string, key: string): string | undefined => {
  const line = splitLines(content).find((existing) => setsKey(existing, key))
  const value = line?.slice(key.length + 1)
  return value ? value : undefined
}
