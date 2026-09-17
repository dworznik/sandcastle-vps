import type { Connector } from './connectors/types.js'
import {
  REQUIRED_PERMISSIONS,
  SIGNING_KEY_PAGE,
  TOKEN_PAGE,
  checkToken,
  isRegistered,
} from './github.js'
import { composeScript, fail, harnessPort, readEnvScript, writeTargetEnv } from './install.js'
import type { LocalShell } from './local.js'
import type { Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { ensureKeyScript, parseSigningKey, signingKeyPath } from './signing-key.js'
import { readEnv, upsertAllEnv, type UpsertMode } from './target-env.js'
import { formatChecks, verifyInstall, type Check, type VerifyOptions } from './verify.js'

/**
 * Capturing the agent's identity on the operator's machine and writing it into
 * the Target, once.
 *
 * The credentials are the Harness's rather than each Project's (ADR 0006), so
 * this runs per Target and not per Project — which is what makes it a step of
 * install/upgrade instead of a step of Onboarding.
 *
 * Three rules hold everywhere in here, and each one is a way a secret used to
 * escape:
 *
 * - Nothing is typed where it can be seen. Every prompt for a secret is
 *   `prompter.secret`, which readline does not echo.
 * - Nothing travels as an argument. Target-side scripts carry no credential;
 *   the environment file goes over stdin, and the GitHub check puts the token
 *   in a header rather than on a `curl` command line.
 * - Nothing is stored here. The Target profile on this machine holds paths and
 *   a host, and the captured values are forgotten when the process exits.
 */

/**
 * The environment keys the Target's compose file reads the agent's identity
 * from.
 *
 * Restated rather than imported from `src/env.ts`: that module parses the
 * process environment at import time and calls `process.exit` when it is
 * incomplete, which is right for the Harness and fatal for a CLI that has no
 * Harness environment. A test keeps the two lists in step.
 */
export const CREDENTIAL_ENV = {
  agentToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  githubToken: 'GH_TOKEN',
  gitName: 'AGENT_GIT_NAME',
  gitEmail: 'AGENT_GIT_EMAIL',
} as const

export type CredentialName = keyof typeof CREDENTIAL_ENV

/** Asked in this order because the signing key's comment is the agent's email,
 *  so the identity has to be known before the key is generated. */
export const CAPTURE_ORDER: readonly CredentialName[] = [
  'agentToken',
  'githubToken',
  'gitName',
  'gitEmail',
]

/** What each one is called when the operator is choosing between them. */
export const CREDENTIAL_LABEL: Readonly<Record<CredentialName, string>> = {
  agentToken: 'Claude token',
  githubToken: 'GitHub token',
  gitName: 'Author name',
  gitEmail: 'Author email',
}

/** Which of them the Target does not hold yet. An empty `KEY=` is what the
 *  environment file scaffolds, and `readEnv` already reads that as absent —
 *  the same reading the Harness itself makes. */
export const missing = (envContent: string): CredentialName[] =>
  CAPTURE_ORDER.filter((name) => readEnv(envContent, CREDENTIAL_ENV[name]) === undefined)

/**
 * The token in `claude setup-token`'s output.
 *
 * It prints explanatory text around the token, and a reader that took the
 * whole stream produced a token with the banner concatenated onto it — whose
 * first symptom was an authentication failure inside a Run, hours downstream
 * of the cause. Last match wins: instructions that mention a token come before
 * the real one. Ported from the retired host path, which learned this the hard
 * way (`scripts/vps/lib/common.sh`).
 */
export const findAgentToken = (text: string): string | undefined =>
  text.match(/sk-ant-[A-Za-z0-9_-]{20,}/gu)?.at(-1)

export interface CredentialSession {
  readonly profile: TargetProfile
  readonly connector: Connector
  readonly prompter: Prompter
  readonly local: LocalShell
  /** How this machine reaches GitHub's API. Injected only so the flow can be
   *  driven in a test; the wizard leaves it alone and gets `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch
}

type Log = (line: string) => void

// ------------------------------------------------------------- one at a time

const captureAgentToken = async (
  { prompter, local }: CredentialSession,
  log: Log,
): Promise<string> => {
  if (await local.has('claude')) {
    log('\nRunning `claude setup-token` here — finish the flow it opens.')
    log('Its output is read for the token; the token itself is never printed.\n')
    const { code, stdout } = await local.interactive('claude', ['setup-token'])
    const found = findAgentToken(stdout)
    if (found) {
      log('  Got it.')
      return found
    }
    log(
      code === 0
        ? '\n  It printed nothing this recognised as a token — paste it instead.'
        : `\n  It exited ${code} — paste the token instead.`,
    )
  } else {
    log('\nClaude Code is not on this machine, so the token has to be pasted.')
    log('Make one where it is installed:  claude setup-token')
  }

  for (;;) {
    const pasted = await prompter.secret('Claude token')
    const found = findAgentToken(pasted)
    if (found) return found
    // Scanned rather than taken whole for the same reason as above: a paste
    // that brought the banner with it is the common shape of this answer.
    log('  No sk-ant-… token in that. Paste the token itself, or the whole output.')
  }
}

const captureGithubToken = async (
  { prompter, local, fetchImpl }: CredentialSession,
  log: Log,
): Promise<string> => {
  log('\nA fine-grained personal access token — how a Run pushes and opens pull requests.')
  log(`  ${TOKEN_PAGE}`)
  log(REQUIRED_PERMISSIONS)
  await local.open(TOKEN_PAGE)

  for (;;) {
    const token = await prompter.secret('GitHub token')
    for (;;) {
      const answer = await checkToken(token, fetchImpl)
      log(`  ${answer.detail}`)
      // An unverified token is never written — a token that only fails at
      // `git push`, inside a Run, an hour later, is the failure this step
      // exists to prevent.
      if (answer.ok) return token
      // GitHub answering "no" and GitHub not answering are different problems.
      // A rejected token means paste a different one; an unreachable GitHub
      // means the same token may be fine, so offer the check again rather than
      // making the operator re-paste something that was never the issue.
      if (answer.reached) break
      if (!(await prompter.confirm('  Try the check again?', true))) {
        throw new Error(
          'GitHub could not be reached to check the token, and an unchecked token is not ' +
            'written. The credentials already captured are on the Target; re-run ' +
            'install/upgrade to finish.',
        )
      }
    }
  }
}

const gitConfig = async (local: LocalShell, key: string): Promise<string | undefined> => {
  const { code, stdout } = await local.run('git', ['config', '--get', key])
  return code === 0 && stdout.trim() ? stdout.trim() : undefined
}

const captureGitName = async (
  { prompter, local }: CredentialSession,
  log: Log,
): Promise<string> => {
  log("\nWho a Run's commits are authored by — the operator, not a bot.")
  return prompter.text('Author name', await gitConfig(local, 'user.name'))
}

const captureGitEmail = async (
  { prompter, local }: CredentialSession,
  log: Log,
): Promise<string> => {
  log('  The address has to be one GitHub has verified on the account, or the')
  log('  commits arrive unattributed and the signature does not count as yours.')
  return prompter.text('Author email', await gitConfig(local, 'user.email'))
}

const CAPTURE: Record<CredentialName, (session: CredentialSession, log: Log) => Promise<string>> = {
  agentToken: captureAgentToken,
  githubToken: captureGithubToken,
  gitName: captureGitName,
  gitEmail: captureGitEmail,
}

// --------------------------------------------------------------- signing key

/**
 * Ask GitHub once whether it holds this key for signing. `undefined` means it
 * could not be asked, which is a third answer and not a "no".
 *
 * `gh` and not the PAT just captured: reading an account's signing keys needs a
 * user-level permission a fine-grained repository token does not carry, and
 * `gh` is already authenticated as the operator.
 */
const askGitHub = async (
  { local }: CredentialSession,
  publicKey: string,
  log?: Log,
): Promise<boolean | undefined> => {
  if (!(await local.has('gh'))) return undefined
  const { code, stdout, stderr } = await local.run('gh', ['api', 'user/ssh_signing_keys'])
  if (code !== 0) {
    log?.(`  gh could not ask: ${stderr.trim().split('\n').at(-1) ?? `it exited ${code}`}`)
    return undefined
  }
  return isRegistered(stdout, publicKey)
}

/**
 * Send the operator to the page, then confirm what they did by asking GitHub
 * rather than by asking them. Without `gh` it can only take their word, and
 * says that it is doing so.
 */
const walkRegistration = async (
  session: CredentialSession,
  publicKey: string,
  log: Log,
): Promise<boolean> => {
  const { prompter, local } = session
  log('\n  Register this as a **signing** key — the type is a dropdown on the page:')
  log(`\n  ${publicKey}\n`)
  log(`  ${SIGNING_KEY_PAGE}`)
  await local.open(SIGNING_KEY_PAGE)

  if (!(await local.has('gh'))) {
    log('  `gh` is not on this machine, so this cannot confirm the registration from here.')
    return prompter.confirm('  Registered it?', true)
  }
  for (;;) {
    await prompter.confirm('  Registered it? Press enter to check with GitHub', true)
    const answer = await askGitHub(session, publicKey, log)
    if (answer === true) {
      log('  GitHub lists it as a signing key.')
      return true
    }
    if (answer === false) {
      log('  GitHub does not list it among the signing keys.')
      // The page adds both kinds and the type is a dropdown, so the key is
      // usually there — as an authentication key, which signs nothing.
      log('  If you added it, check the type: an authentication key does not sign.')
    }
    if (!(await prompter.confirm('  Check again?', true))) return false
  }
}

/**
 * Put a signing key on the Target and get it registered. Returns whether the
 * registration was confirmed — a key that exists and is not registered
 * produces Runs whose commits push and then show as unverified.
 */
export const ensureSigningKey = async (
  session: CredentialSession,
  comment: string,
  envContent: string,
  log: Log,
  replace = false,
): Promise<boolean> => {
  const { profile, connector } = session
  const path = signingKeyPath(profile.installDir, envContent)
  log(replace ? '\nCommit signing key — rotating' : '\nCommit signing key')
  const result = await connector.exec(ensureKeyScript(path, comment, replace))
  if (result.code !== 0 && result.stdout.trim() === '') {
    throw fail('Generating the signing key', result.code, result.stderr)
  }
  const { publicKey, created } = parseSigningKey(result.stdout)
  log(created ? `  Generated on the Target at ${path}.` : `  Already on the Target at ${path}.`)
  if (replace) {
    // The old key is gone from the Target, so the registration GitHub still
    // holds is for a key nothing will sign with. Until the new one is
    // registered, a Run's commits push and show as unverified.
    log('  The previous key is replaced. Its registration on GitHub is now stale —')
    log('  remove it there once the new one below is in.')
  }

  // A key that was already there is usually a key that was already registered,
  // and every upgrade re-runs this. Ask GitHub before asking the operator:
  // sending them to a web page to re-confirm something that is already true is
  // how a step people skip gets created.
  if (!created && (await askGitHub(session, publicKey)) === true) {
    log('  GitHub already lists it as a signing key.')
    return true
  }
  return walkRegistration(session, publicKey, log)
}

// ---------------------------------------------------------------- the action

export interface CaptureOptions {
  /** Which credentials to ask for. Defaults to the ones the Target does not
   *  hold, which is what makes re-running install/upgrade silent once it has
   *  them. Rotation passes this list, chosen, with `mode: 'rotate'`. */
  readonly which?: readonly CredentialName[]
  /** `seed` fills what is empty; `rotate` replaces what is there. Capture is
   *  the first, rotation the second — and they differ in nothing else, which
   *  is why they are one flow. */
  readonly mode?: UpsertMode
  /** Regenerate the signing key rather than keeping the one on the Target. */
  readonly replaceSigningKey?: boolean
  /** Passed through to the check that follows the restart, so a test does not
   *  spend its timeout in the retry loop. */
  readonly verifyOptions?: Partial<VerifyOptions>
}

/**
 * What the Target looks like afterwards. Three answers rather than one,
 * because they fail for different reasons and the operator's next move differs
 * for each: a credential that was not captured is re-run to finish, an
 * unregistered key is a web page to revisit, and a Harness that stopped
 * answering is a container log to read.
 */
export interface CaptureResult {
  /** Whether the Target now holds every credential a Run needs. */
  readonly complete: boolean
  /** Whether GitHub has the signing key, for signing. */
  readonly registered: boolean
  /** The checks run against the restarted Harness — empty when nothing
   *  changed, so nothing was restarted and the install's own pass still
   *  stands. */
  readonly checks: readonly Check[]
}

/**
 * The credential step of install/upgrade: capture whatever the Target does not
 * hold, write it in, put a signing key there, and restart the Harness holding
 * it. Asking only for what is missing is what makes re-running silent once the
 * Target has them — and replacing one that is already there is rotation, which
 * is #37's action and asks first.
 */
export const captureCredentials = async (
  session: CredentialSession,
  log: Log = console.log,
  { which, mode = 'seed', replaceSigningKey = false, verifyOptions = {} }: CaptureOptions = {},
): Promise<CaptureResult> => {
  const { profile, connector } = session

  const current = await connector.exec(readEnvScript(profile.installDir))
  const existing = current.stdout
  // Ordered by CAPTURE_ORDER whatever order the caller listed them in: the
  // signing key's comment is the agent's email, so the identity has to be
  // captured before the key is generated.
  const asked = which ?? missing(existing)
  const wanted = CAPTURE_ORDER.filter((name) => asked.includes(name))

  log('\nCredentials')
  log('Held by the Harness and injected into each Run (ADR 0006) — no Project')
  log('carries a copy. The two tokens are never echoed; nothing asked for here is')
  log('stored on this machine or passed as a command argument.')

  if (wanted.length === 0) {
    log('\nThe Target already holds all of them. Nothing to capture.')
  }

  const captured: Record<string, string> = {}
  for (const name of wanted) {
    captured[CREDENTIAL_ENV[name]] = await CAPTURE[name](session, log)
  }

  // Seeded, never rotated, for the same reason the install seeds: only the keys
  // that were empty are being filled, and a write that replaced the rest would
  // undo an operator's edit on every upgrade.
  const written = upsertAllEnv(existing, captured, mode)
  if (wanted.length > 0) {
    await writeTargetEnv(connector, profile.installDir, written)
    log(
      `\nWrote ${wanted.length} credential${wanted.length === 1 ? '' : 's'} into ` +
        `${profile.installDir}/.env (mode 600). They went over stdin, not in the script.`,
    )
  }

  const email =
    captured[CREDENTIAL_ENV.gitEmail] ?? readEnv(existing, CREDENTIAL_ENV.gitEmail) ?? 'agent'
  const registered = await ensureSigningKey(session, email, existing, log, replaceSigningKey)

  // Only an environment change needs the restart. A key generated just now is
  // already visible to a running Harness: compose bind-mounts the secrets
  // directory, and `agentSandbox` checks the file exists per Run rather than at
  // startup — so a Harness that has its credentials and gained a key does not
  // need bouncing.
  let checks: readonly Check[] = []
  if (wanted.length > 0) {
    log('\nRestarting the Harness so it holds them…')
    const up = await connector.exec(composeScript(profile.installDir, 'up -d'))
    if (up.code !== 0) throw fail('docker compose up', up.code, up.stderr)

    // Checked again, because the earlier pass ran against the container this
    // one replaced — on an upgrade that is a Harness with the *previous*
    // credentials, and this is the one that will take a Dispatch. Returned
    // rather than only logged: a Harness that came back wrong is not a Target
    // to send the operator off to add a Project to.
    log('\nChecking it from here…')
    checks = await verifyInstall(connector, {
      installDir: profile.installDir,
      harnessPort: harnessPort(existing),
      ...verifyOptions,
    })
    log(formatChecks(checks))
  }

  return { complete: missing(written).length === 0, registered, checks }
}
