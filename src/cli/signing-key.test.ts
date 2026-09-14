import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEY_FILE, ensureKeyScript, parseSigningKey, signingKeyPath } from './signing-key.js'

const INSTALL_DIR = '/home/op/.sandcastle-vps'

const answer = (lines: Record<string, string>): string =>
  Object.entries(lines)
    .map(([key, value]) => `${key}\t${value}`)
    .join('\n')

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH000 agent@example.com'

describe('signingKeyPath', () => {
  it('puts the key in the secrets directory the install created', () => {
    expect(signingKeyPath(INSTALL_DIR)).toBe(`${INSTALL_DIR}/secrets/${KEY_FILE}`)
  })

  // compose derives AGENT_SIGNING_KEY from SECRETS_DIR and this file name, and
  // the Harness reads the path compose gives it. If the two ever disagree the
  // Harness looks for a key that is not there — and the first sign of it is a
  // Run failing to sign, on a Target, after an install that looked fine.
  it('names the file compose expects to find', async () => {
    const compose = await readFile(join(import.meta.dirname, '..', '..', 'compose.yaml'), 'utf8')
    expect(compose).toContain(
      `\${SECRETS_DIR:?set to the directory holding the signing key}/${KEY_FILE}`,
    )
  })
})

describe('ensureKeyScript', () => {
  const script = ensureKeyScript(INSTALL_DIR, 'agent@example.com')

  // Nothing is at the Target's terminal to type a passphrase when a Run signs
  // a commit, so a key with one is a key that hangs every Run.
  it('generates a passphraseless ed25519 key', () => {
    expect(script).toContain('-t ed25519')
    expect(script).toContain("-N ''")
  })

  it('cannot be made to prompt', () => {
    expect(script).toContain('< /dev/null')
  })

  // An upgrade re-runs this. Replacing the key would invalidate the
  // registration the operator made on GitHub and leave every later Run signing
  // with a key the account does not know.
  it('keeps a key that is already there', () => {
    expect(script).toContain('if [ -f "$key" ]')
    expect(script).toContain("printf 'state\\tkept\\n'")
  })

  it('leaves the key readable only by its owner', () => {
    expect(script).toContain('umask 077')
    expect(script).toContain('chmod 600 "$key"')
  })

  it('quotes the comment it was handed, rather than pasting it into a command', () => {
    expect(ensureKeyScript(INSTALL_DIR, "o'brien@example.com")).toContain(
      `'o'\\''brien@example.com'`,
    )
  })
})

describe('parseSigningKey', () => {
  it('reads the public half and whether this run made it', () => {
    expect(parseSigningKey(answer({ state: 'created', public: PUBLIC_KEY }))).toEqual({
      publicKey: PUBLIC_KEY,
      created: true,
    })
    expect(parseSigningKey(answer({ state: 'kept', public: PUBLIC_KEY })).created).toBe(false)
  })

  // The script reports a missing binary as a value rather than a non-zero
  // exit, the way preflight reports a missing Docker — so that this can say
  // what to install instead of "the command failed".
  it('raises what the Target said was wrong', () => {
    expect(() => parseSigningKey(answer({ error: 'ssh-keygen is not on the Target' }))).toThrow(
      /ssh-keygen is not on the Target/,
    )
  })

  it('refuses to invent a key when the Target answered nothing', () => {
    expect(() => parseSigningKey('')).toThrow(/no public key/)
    expect(() => parseSigningKey(answer({ state: 'created', public: '' }))).toThrow(/no public key/)
  })
})
