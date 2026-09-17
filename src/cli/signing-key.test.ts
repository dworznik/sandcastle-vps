import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { KEY_FILE, ensureKeyScript, parseSigningKey, signingKeyPath } from './signing-key.js'

const exec = promisify(execFile)

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

  // The install *seeds* SECRETS_DIR and never overwrites it, and `divergences`
  // deliberately keeps the stored value while only reporting the one it would
  // have written. So a profile repointed at a new installDir leaves the two
  // disagreeing — and deriving the path from the profile would write the key
  // somewhere the Harness is not looking, which surfaces as agent.ts's "there
  // is no file there" on the first Run.
  it('follows the Target, not the profile, when the two disagree', () => {
    const env = 'SECRETS_DIR=/srv/sandcastle/secrets\nWORKSPACE_ROOT=/home/op/work\n'
    expect(signingKeyPath(INSTALL_DIR, env)).toBe(`/srv/sandcastle/secrets/${KEY_FILE}`)
  })

  it('falls back to the profile for a Target with no environment file yet', () => {
    expect(signingKeyPath(INSTALL_DIR, 'SECRETS_DIR=\n')).toBe(`${INSTALL_DIR}/secrets/${KEY_FILE}`)
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

// What the script does is asserted against a real ssh-keygen below. These two
// are the properties a run against a well-behaved key cannot show: that it
// could not be made to prompt even by a Target that has a terminal, and that a
// comment is quoted rather than pasted into a command.
describe('ensureKeyScript', () => {
  const script = ensureKeyScript(signingKeyPath(INSTALL_DIR), 'agent@example.com')

  it('cannot be made to prompt', () => {
    expect(script).toContain('< /dev/null')
  })

  it('quotes the comment it was handed, rather than pasting it into a command', () => {
    expect(ensureKeyScript(signingKeyPath(INSTALL_DIR), "o'brien@example.com")).toContain(
      `'o'\\''brien@example.com'`,
    )
  })
})

/**
 * Run the real script against a real key, the way `scripts/agent-token.test.ts`
 * drives the real bash the Target runs. Everything this script protects against
 * — an encrypted key, a key of the wrong type, a `.pub` that belongs to some
 * other key — is a property of `ssh-keygen`, not of a string, and asserting on
 * the script's text would only pin the assertion to today's spelling of it.
 */
const runScript = async (
  setup: (dir: string) => Promise<void> = async () => {},
): Promise<{ answer: string; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sandcastle-key-'))
  await setup(dir)
  const { stdout } = await exec(
    'bash',
    ['-c', ensureKeyScript(join(dir, 'agent_signing_key'), 'agent@example.com')],
    { timeout: 20_000 },
  )
  return { answer: stdout, dir }
}

const keygen = (args: string[]): Promise<unknown> => exec('ssh-keygen', args, { timeout: 20_000 })

describe('ensureKeyScript, against a real ssh-keygen', () => {
  it('generates a passphraseless ed25519 key it can then read back', async () => {
    const { answer, dir } = await runScript()
    const key = parseSigningKey(answer)
    expect(key.created).toBe(true)
    expect(key.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps a key that is already there rather than replacing it', async () => {
    const first = await runScript()
    const before = await readFile(join(first.dir, 'agent_signing_key'), 'utf8')

    const { stdout } = await exec(
      'bash',
      ['-c', ensureKeyScript(join(first.dir, 'agent_signing_key'), 'agent@example.com')],
      { timeout: 20_000 },
    )
    const second = parseSigningKey(stdout)
    expect(second.created).toBe(false)
    expect(second.publicKey).toBe(parseSigningKey(first.answer).publicKey)
    expect(await readFile(join(first.dir, 'agent_signing_key'), 'utf8')).toBe(before)
    await rm(first.dir, { recursive: true, force: true })
  })

  // A `.pub` left behind by a different key would otherwise be the half
  // registered on GitHub, while every Run signed with the private key beside
  // it — a mismatch whose only symptom is a pushed commit showing unverified.
  it('reports the key that belongs to the private half, not a stale .pub', async () => {
    const { answer, dir } = await runScript(async (created) => {
      const key = join(created, 'agent_signing_key')
      await keygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'real', '-f', key])
      const stray = join(created, 'stray')
      await keygen(['-q', '-t', 'ed25519', '-N', '', '-C', 'stray', '-f', stray])
      await writeFile(`${key}.pub`, await readFile(`${stray}.pub`, 'utf8'))
    })

    const derived = (await exec('ssh-keygen', ['-y', '-f', join(dir, 'agent_signing_key')])).stdout
    expect(parseSigningKey(answer).publicKey.split(' ')[1]).toBe(derived.trim().split(' ')[1])
    expect(parseSigningKey(answer).publicKey).not.toContain('stray')
    await rm(dir, { recursive: true, force: true })
  })

  // Nothing is at the Target's terminal to type a passphrase when a Run signs,
  // so an encrypted key is not a key this can use — and keeping it would send
  // the operator to GitHub to register a key that can never sign.
  it('refuses a key that has a passphrase instead of keeping it', async () => {
    const { answer, dir } = await runScript(async (created) => {
      await keygen([
        '-q',
        '-t',
        'ed25519',
        '-N',
        'not-passphraseless',
        '-C',
        'encrypted',
        '-f',
        join(created, 'agent_signing_key'),
      ])
    })
    expect(() => parseSigningKey(answer)).toThrow(/passphrase/)
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a key that is not ed25519', async () => {
    const { answer, dir } = await runScript(async (created) => {
      // ecdsa rather than rsa: it is the same "not ed25519" to the script, and
      // generates in a fraction of the time an RSA key does.
      await keygen([
        '-q',
        '-t',
        'ecdsa',
        '-b',
        '256',
        '-N',
        '',
        '-C',
        'wrong-type',
        '-f',
        join(created, 'agent_signing_key'),
      ])
    })
    expect(() => parseSigningKey(answer)).toThrow(/ed25519/)
    await rm(dir, { recursive: true, force: true })
  })

  it('leaves the key readable only by its owner', async () => {
    const { dir } = await runScript()
    const { stdout } = await exec('stat', ['-c', '%a', join(dir, 'agent_signing_key')])
    expect(stdout.trim()).toBe('600')
    await rm(dir, { recursive: true, force: true })
  })

  describe('rotating', () => {
    const rotate = async (dir: string) =>
      exec('bash', ['-c', ensureKeyScript(join(dir, 'agent_signing_key'), 'rotated', true)], {
        timeout: 20_000,
      })

    it('replaces the key it finds, rather than keeping it', async () => {
      const first = await runScript()
      const before = parseSigningKey(first.answer).publicKey

      const rotated = parseSigningKey((await rotate(first.dir)).stdout)
      expect(rotated.created).toBe(true)
      expect(rotated.publicKey).not.toBe(before)
      // And the file on disk is the new one, not a leftover alongside it.
      const derived = (await exec('ssh-keygen', ['-y', '-f', join(first.dir, 'agent_signing_key')]))
        .stdout
      expect(rotated.publicKey.split(' ')[1]).toBe(derived.trim().split(' ')[1])
      await rm(first.dir, { recursive: true, force: true })
    })

    // Rotation is also the way out of a key this refuses to keep — an
    // encrypted one, or one of the wrong type. It would be a poor escape
    // hatch if it inherited the same refusal.
    it('replaces a key that could not have been kept', async () => {
      const { dir } = await runScript(async (created) => {
        await keygen([
          '-q',
          '-t',
          'ed25519',
          '-N',
          'encrypted',
          '-C',
          'old',
          '-f',
          join(created, 'agent_signing_key'),
        ])
      })
      const rotated = parseSigningKey((await rotate(dir)).stdout)
      expect(rotated.created).toBe(true)
      expect(rotated.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
      await rm(dir, { recursive: true, force: true })
    })

    // Generated beside the key and moved into place: a rotation that failed
    // partway must leave the Target with the key it had, not with none.
    it('leaves no temporary key behind', async () => {
      const { dir } = await runScript()
      await rotate(dir)
      const { stdout } = await exec('ls', [dir])
      expect(stdout).not.toContain('.new.')
      expect(stdout.split('\n').filter(Boolean).sort()).toEqual([
        'agent_signing_key',
        'agent_signing_key.pub',
      ])
      await rm(dir, { recursive: true, force: true })
    })
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
