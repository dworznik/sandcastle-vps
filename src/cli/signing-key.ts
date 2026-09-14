import { secretsDir } from './install.js'
import { parseProbe } from './preflight.js'
import { shellQuote } from './shell.js'

/**
 * The agent's commit-signing key, which is generated on the Target and never
 * leaves it.
 *
 * That is not a convenience: a key generated on the operator's machine is a
 * private key that travelled over a connection and sat in the memory of a
 * second process. Only the public half comes back, which is the half that goes
 * on a web page anyway.
 */

/**
 * The key's file name under the secrets directory.
 *
 * Compose derives `AGENT_SIGNING_KEY` from `SECRETS_DIR` and this same name,
 * so the two must agree — the Harness reads the path compose gives it, and a
 * Sandbox's read-only mount resolves that path on the Target. A test asserts
 * compose.yaml still names this file.
 */
export const KEY_FILE = 'agent_signing_key'

export const signingKeyPath = (installDir: string): string =>
  `${secretsDir(installDir)}/${KEY_FILE}`

/**
 * Generate the key if it is not there, and report the public half either way.
 *
 * Idempotent on purpose: an upgrade re-runs credential capture, and a second
 * install that quietly replaced the key would invalidate the registration the
 * operator made on GitHub and leave every later Run signing with a key the
 * account does not know. Replacing it is rotation, which is #37's action and
 * asks first.
 *
 * Nothing here is fatal to the script — a missing `ssh-keygen` is reported as
 * a value, the way preflight reports a missing Docker, because the wizard has
 * something useful to say about it and a non-zero exit would only say "failed".
 */
export const ensureKeyScript = (installDir: string, comment: string): string => {
  const key = shellQuote(signingKeyPath(installDir))
  return `set -eu
umask 077
key=${key}
if ! command -v ssh-keygen > /dev/null 2>&1; then
  printf 'error\\tssh-keygen is not on the Target — install the openssh client on it\\n'
  exit 0
fi
if [ -f "$key" ]; then
  printf 'state\\tkept\\n'
else
  mkdir -p "$(dirname "$key")"
  # -N '' is the passphraseless requirement: nothing is at the Target's
  # terminal to type one when a Run signs a commit. < /dev/null so a stray
  # prompt cannot hang the wizard on a connection with no terminal at all.
  if ssh-keygen -q -t ed25519 -N '' -C ${shellQuote(comment)} -f "$key" < /dev/null; then
    printf 'state\\tcreated\\n'
  else
    printf 'error\\tssh-keygen could not write the key\\n'
    exit 0
  fi
fi
chmod 600 "$key"
printf 'public\\t%s\\n' "$(cat "$key.pub")"`
}

export interface SigningKey {
  /** The public half, as `ssh-ed25519 AAAA… comment`. */
  readonly publicKey: string
  /** Whether this run made it, which decides whether the operator still has to
   *  register it. */
  readonly created: boolean
}

/** Read the script's answer, or say what the Target said instead. Same
 *  `key<TAB>value` wire as preflight and the install's facts probe. */
export const parseSigningKey = (stdout: string): SigningKey => {
  const answer = parseProbe(stdout)
  if (answer.error) throw new Error(answer.error)
  const publicKey = answer.public?.trim()
  if (!publicKey) {
    throw new Error(
      `The Target reported no public key. It answered:\n${stdout.trim() || '(nothing)'}`,
    )
  }
  return { publicKey, created: answer.state === 'created' }
}
