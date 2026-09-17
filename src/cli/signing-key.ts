import { secretsDir } from './install.js'
import { parseProbe } from './preflight.js'
import { shellQuote } from './shell.js'
import { readEnv } from './target-env.js'

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

/**
 * Where the key belongs on this Target.
 *
 * Read out of the Target's own environment file rather than derived from the
 * profile, because those two can legitimately disagree: the install *seeds*
 * `SECRETS_DIR` and never overwrites it, and `divergences` deliberately keeps
 * the stored value while only reporting the one it would have written. Point a
 * profile at a new `installDir` and deriving the path here would write the key
 * under the new directory while the Harness — which reads what compose built
 * from the stored `SECRETS_DIR` — went on looking under the old one. The
 * symptom is `agent.ts`'s "there is no file there", on a Target, after an
 * install that reported success.
 *
 * The profile is the fallback for the one case where the file cannot answer:
 * a Target with no environment file yet.
 */
export const signingKeyPath = (installDir: string, envContent = ''): string =>
  `${readEnv(envContent, 'SECRETS_DIR') ?? secretsDir(installDir)}/${KEY_FILE}`

/**
 * Generate the key if it is not there, prove it is usable, and report the
 * public half either way.
 *
 * Idempotent on purpose: an upgrade re-runs credential capture, and a second
 * install that quietly replaced the key would invalidate the registration the
 * operator made on GitHub and leave every later Run signing with a key the
 * account does not know. Replacing it is rotation, which is #37's action and
 * asks first.
 *
 * But "there is a file there" is not the same as "a Run can sign with it", and
 * the gap between those two is only visible hours later, as a pushed commit
 * GitHub shows as unverified. So the public half is *derived* from the private
 * key rather than read from `<key>.pub`, which settles three things at once:
 *
 * - It proves the two halves belong together. A `.pub` left behind by a
 *   different key would otherwise be the one registered on GitHub while Runs
 *   signed with something else.
 * - It fails, rather than prompting, when the key has a passphrase — there is
 *   nothing at the Target's terminal to type one, on this Connector or any
 *   other (docs/connectors.md), so an encrypted key is not a key this can use.
 * - It names the algorithm, so a key that is not ed25519 is caught here rather
 *   than by `ssh-keygen -Y sign` inside a Run.
 *
 * Nothing here is fatal to the script — a missing `ssh-keygen` is reported as
 * a value, the way preflight reports a missing Docker, because the wizard has
 * something useful to say about it and a non-zero exit would only say "failed".
 */
export const ensureKeyScript = (keyPath: string, comment: string, replace = false): string => {
  const key = shellQuote(keyPath)
  // Rotation generates unconditionally; otherwise an existing key is the
  // answer. Written as two shapes of the same script rather than a flag the
  // script reads, so what runs on the Target says which one it is.
  const keepExisting = replace
    ? ''
    : `if [ -f "$key" ]; then
  state=kept
else`
  const endKeep = replace ? '' : 'fi'
  return `set -eu
umask 077
key=${key}
if ! command -v ssh-keygen > /dev/null 2>&1; then
  printf 'error\\tssh-keygen is not on the Target — install the openssh client on it\\n'
  exit 0
fi
${keepExisting}
  mkdir -p "$(dirname "$key")"
  # Generated beside the key and moved into place, so there is never a moment
  # with no key at all and a failed rotation leaves the old one working. The
  # old private half is replaced rather than kept: a retired signing key that
  # stays on disk is a credential nobody is watching any more.
  tmp="$key.new.$$"
  rm -f "$tmp" "$tmp.pub"
  # -N '' is the passphraseless requirement: nothing is at the Target's
  # terminal to type one when a Run signs a commit. < /dev/null so a stray
  # prompt cannot hang the wizard on a connection with no terminal at all.
  if ssh-keygen -q -t ed25519 -N '' -C ${shellQuote(comment)} -f "$tmp" < /dev/null; then
    mv -f "$tmp" "$key"
    mv -f "$tmp.pub" "$key.pub"
    state=created
  else
    rm -f "$tmp" "$tmp.pub"
    printf 'error\\tssh-keygen could not write the key\\n'
    exit 0
  fi
${endKeep}
chmod 600 "$key"
# stderr is discarded rather than reported: it is multi-line, and one stray
# newline in it would be read as another field of the key/value protocol.
if ! public="$(ssh-keygen -y -f "$key" < /dev/null 2> /dev/null)"; then
  printf 'error\\tThe key at %s cannot be read — it has a passphrase, or it is not a private key. A Run cannot sign with it; move it aside and re-run to generate a new one.\\n' "$key"
  exit 0
fi
case "$public" in
  'ssh-ed25519 '*) ;;
  *)
    printf 'error\\tThe key at %s is not an ed25519 key. Move it aside and re-run to generate one.\\n' "$key"
    exit 0
    ;;
esac
printf 'state\\t%s\\n' "$state"
printf 'public\\t%s\\n' "$public"`
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
