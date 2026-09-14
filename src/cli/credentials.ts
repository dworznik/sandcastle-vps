import type { Connector } from './connectors/types.js'
import {
  REQUIRED_PERMISSIONS,
  SIGNING_KEY_PAGE,
  TOKEN_PAGE,
  checkToken,
  isRegistered,
} from './github.js'
import { composeScript, fail, harnessPort, readEnvScript, writeEnvScript } from './install.js'
import type { LocalShell } from './local.js'
import type { Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { ensureKeyScript, parseSigningKey, signingKeyPath } from './signing-key.js'
import { readEnv, upsertAllEnv, type UpsertMode } from './target-env.js'
import { formatChecks, verifyInstall, type VerifyOptions } from './verify.js'

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
export const ORDER: readonly CredentialName[] = ['agentToken', 'githubToken', 'gitName', 'gitEmail']

/** Which of them the Target does not hold yet. An empty `KEY=` is what the
 *  environment file scaffolds, and `readEnv` already reads that as absent —
 *  the same reading the Harness itself makes. */
export const missing = (envContent: string): CredentialName[] =>
  ORDER.filter((name) => readEnv(envContent, CREDENTIAL_ENV[name]) === undefined)

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
    const answer = await checkToken(token, fetchImpl)
    log(`  ${answer.detail}`)
    if (answer.ok) return token
    // A token GitHub rejected is never accepted — that is the point of asking.
    // A token GitHub was never asked about is a different failure, and being
    // unable to install from behind a proxy is not an improvement in safety.
    if (!answer.reached && (await prompter.confirm('  Accept it without checking?'))) {
      return token
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
 * Confirm the operator registered the key, by asking GitHub rather than asking
 * them.
 *
 * `gh` and not the PAT just captured: reading an account's signing keys needs a
 * user-level permission a fine-grained repository token does not carry, and
 * `gh` is already authenticated as the operator. Without it this falls back to
 * taking their word for it, and says that it is doing so.
 */
const confirmRegistration = async (
  { prompter, local }: CredentialSession,
  publicKey: string,
  log: Log,
): Promise<boolean> => {
  if (!(await local.has('gh'))) {
    log('  `gh` is not on this machine, so this cannot confirm the registration from here.')
    return prompter.confirm('  Registered it?', true)
  }
  for (;;) {
    await prompter.confirm('  Registered it? Press enter to check with GitHub', true)
    const { code, stdout, stderr } = await local.run('gh', ['api', 'user/ssh_signing_keys'])
    if (code !== 0) {
      log(`  gh could not ask: ${stderr.trim().split('\n').at(-1) ?? `it exited ${code}`}`)
    } else if (isRegistered(stdout, publicKey)) {
      log('  GitHub lists it as a signing key.')
      return true
    } else {
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
  log: Log,
): Promise<boolean> => {
  const { profile, connector, local } = session
  log('\nCommit signing key')
  const result = await connector.exec(ensureKeyScript(profile.installDir, comment))
  if (result.code !== 0 && result.stdout.trim() === '') {
    throw fail('Generating the signing key', result.code, result.stderr)
  }
  const { publicKey, created } = parseSigningKey(result.stdout)
  const path = signingKeyPath(profile.installDir)
  log(created ? `  Generated on the Target at ${path}.` : `  Already on the Target at ${path}.`)

  if (!created) {
    // Re-registering a key it already has is a no-op on GitHub's side, but
    // sending the operator to a web page on every upgrade is not.
    const confirmed = await confirmRegistration(session, publicKey, log)
    if (confirmed) return true
    log(`\n  ${publicKey}\n`)
    log(`  Register it as a signing key: ${SIGNING_KEY_PAGE}`)
    return false
  }

  log('\n  Register this as a **signing** key — the type is a dropdown on the page:')
  log(`\n  ${publicKey}\n`)
  log(`  ${SIGNING_KEY_PAGE}`)
  await local.open(SIGNING_KEY_PAGE)
  return confirmRegistration(session, publicKey, log)
}

// ---------------------------------------------------------------- the action

export interface CaptureOptions {
  /** Which credentials to ask for. Defaults to the ones the Target does not
   *  hold — which is what makes re-running install/upgrade silent once it has
   *  them. Rotation (#37) is this list, chosen, with `mode: 'rotate'`. */
  readonly which?: readonly CredentialName[]
  readonly mode?: UpsertMode
  /** Passed through to the check that follows the restart, so a test does not
   *  spend its timeout in the retry loop. */
  readonly verifyOptions?: Partial<VerifyOptions>
}

/**
 * The credential step of install/upgrade: capture what is missing, write it
 * into the Target, put a signing key there, and restart the Harness holding it.
 *
 * Returns whether the Target now holds a complete identity.
 */
export const captureCredentials = async (
  session: CredentialSession,
  log: Log = console.log,
  { which, mode = 'seed', verifyOptions = {} }: CaptureOptions = {},
): Promise<boolean> => {
  const { profile, connector } = session

  const current = await connector.exec(readEnvScript(profile.installDir))
  const existing = current.stdout
  const wanted = ORDER.filter((name) => (which ?? missing(existing)).includes(name))

  log('\n── Credentials ' + '─'.repeat(56))
  log('Held by the Harness and injected into each Run (ADR 0006) — no Project')
  log('carries a copy. Nothing typed here is echoed, stored on this machine, or')
  log('passed as a command argument.')

  if (wanted.length === 0) {
    log('\nThe Target already holds all of them. Nothing to capture.')
  }

  const captured: Record<string, string> = {}
  for (const name of wanted) {
    captured[CREDENTIAL_ENV[name]] = await CAPTURE[name](session, log)
  }

  if (wanted.length > 0) {
    const content = upsertAllEnv(existing, captured, mode)
    const written = await connector.exec(writeEnvScript(profile.installDir), { stdin: content })
    if (written.code !== 0) {
      throw fail('Writing the environment file', written.code, written.stderr)
    }
    log(
      `\nWrote ${wanted.length} credential${wanted.length === 1 ? '' : 's'} into ` +
        `${profile.installDir}/.env (mode 600). They went over stdin, not in the script.`,
    )
  }

  const email =
    captured[CREDENTIAL_ENV.gitEmail] ?? readEnv(existing, CREDENTIAL_ENV.gitEmail) ?? 'agent'
  const registered = await ensureSigningKey(session, email, log)

  if (wanted.length > 0) {
    log('\nRestarting the Harness so it holds them…')
    const up = await connector.exec(composeScript(profile.installDir, 'up -d'))
    if (up.code !== 0) throw fail('docker compose up', up.code, up.stderr)

    // The restart is what the checks are for: an upgrade's earlier pass ran
    // against the previous container, and this one is the Harness that will
    // actually take a Dispatch.
    log('\nChecking it from here…')
    const checks = await verifyInstall(connector, {
      installDir: profile.installDir,
      harnessPort: harnessPort(existing),
      ...verifyOptions,
    })
    log(formatChecks(checks))
  }

  return missing(upsertAllEnv(existing, captured, mode)).length === 0 && registered
}
