import { createReadStream } from 'node:fs'
import type { Connector } from './connectors/types.js'
import { ensureNetworkScript, PLATFORM_NETWORK } from './network.js'
import { packSelf, packageVersion } from './package.js'
import { seededToggles } from './posture.js'
import { describeTarget, type TargetProfile } from './profiles.js'
import { parseProbe } from './preflight.js'
import { shellQuote } from './shell.js'
import { readEnv, upsertAllEnv } from './target-env.js'
import { formatChecks, verifyInstall, type Check, type VerifyOptions } from './verify.js'

/**
 * Install and upgrade: deliver the package, build the Harness image on the
 * Target, write the Target's environment, bring the stack up, and check it
 * from outside.
 *
 * Everything about a Target that the Target itself knows — who the operator
 * is, which group opens the Docker socket, what random bytes look like — is
 * read off the Target rather than guessed here, which is what lets one CLI
 * install onto machines it shares no assumptions with.
 */

/** Where the signing key lives, under the install directory. Compose mounts
 *  this directory into the Harness at path parity and derives the key's own
 *  file name from it, so this decides the directory and compose decides the
 *  name — between them, nothing else needs to know the layout. */
export const secretsDir = (installDir: string): string => `${installDir}/secrets`

export interface TargetFacts {
  readonly operatorUid: string
  readonly operatorGid: string
  /** Empty when the Target has no docker group — preflight refuses first. */
  readonly dockerGid: string
  readonly inngestEventKey: string
  readonly inngestSigningKey: string
}

/**
 * One round trip for everything the environment file is seeded from. The
 * Inngest keys are generated here, on the Target: they are secrets, and a
 * secret generated on the operator's machine is a secret that travelled.
 *
 * They are generated on every run and usually discarded — seeding keeps
 * whatever the file already has — which costs nothing and keeps this a single
 * script with no branch that depends on what is already installed.
 */
export const FACTS_SCRIPT = `set -eu
rand() {
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -hex 32
  else
    # coreutils, so no second binary to require of a Target.
    od -An -N32 -tx1 /dev/urandom | tr -d ' \\n'
  fi
}
printf 'uid\\t%s\\n' "$(id -u)"
printf 'gid\\t%s\\n' "$(id -g)"
docker_gid="$(getent group docker 2> /dev/null | cut -d: -f3 || true)"
if [ -z "$docker_gid" ]; then
  docker_gid="$(awk -F: '$1 == "docker" { print $3 }' /etc/group 2> /dev/null || true)"
fi
printf 'docker-gid\\t%s\\n' "$docker_gid"
printf 'event-key\\t%s\\n' "$(rand)"
printf 'signing-key\\t%s\\n' "$(rand)"`

export const parseFacts = (stdout: string): TargetFacts => {
  // The same `key<TAB>value` wire preflight uses, and the same reader: two
  // scripts asking the Target about itself should not disagree about how it
  // answers. `preflight.ts` is where that protocol lives (docs/connectors.md).
  const facts = parseProbe(stdout)
  const required = ['uid', 'gid', 'event-key', 'signing-key'] as const
  const missing = required.filter((key) => !facts[key])
  if (missing.length > 0) {
    throw new Error(
      `The Target did not report ${missing.join(', ')}. It answered:\n${stdout.trim() || '(nothing)'}`,
    )
  }
  if (!facts['docker-gid']) {
    throw new Error(
      'The Target has no `docker` group, so the Harness container could not use its Docker ' +
        'socket. Install Docker Engine on it first.',
    )
  }
  return {
    operatorUid: facts.uid?.trim() ?? '',
    operatorGid: facts.gid?.trim() ?? '',
    dockerGid: facts['docker-gid'].trim(),
    inngestEventKey: facts['event-key']?.trim() ?? '',
    inngestSigningKey: facts['signing-key']?.trim() ?? '',
  }
}

/**
 * What this install would write, if the file were empty. Credentials are
 * absent on purpose: the wizard captures those, and an install that wrote
 * empty placeholders over them would be an install that logs the operator out.
 *
 * The two toggles are seeded off (ADR 0010): a fresh Target is Run-only, and
 * seeding is what carries a toggle the operator turned on across an upgrade.
 */
export const desiredEnv = (
  profile: TargetProfile,
  facts: TargetFacts,
): Readonly<Record<string, string>> => ({
  WORKSPACE_ROOT: profile.workspaceRoot,
  SECRETS_DIR: secretsDir(profile.installDir),
  OPERATOR_UID: facts.operatorUid,
  OPERATOR_GID: facts.operatorGid,
  DOCKER_GID: facts.dockerGid,
  INNGEST_EVENT_KEY: facts.inngestEventKey,
  INNGEST_SIGNING_KEY: facts.inngestSigningKey,
  ...seededToggles(),
})

/** A setting the Target already has that this install would have written
 *  differently. Seeded values win, so these are reported rather than applied —
 *  silently keeping a stale workspace root is how a Run ends up looking for
 *  Projects in a directory the operator stopped using. */
export interface Divergence {
  readonly key: string
  readonly kept: string
  readonly offered: string
}

/** Only the settings an operator would recognise: reporting that a freshly
 *  generated Inngest key differs from the stored one would be reporting that
 *  random numbers are random. */
const REPORTED = ['WORKSPACE_ROOT', 'SECRETS_DIR', 'OPERATOR_UID', 'OPERATOR_GID', 'DOCKER_GID']

export const divergences = (
  existing: string,
  desired: Readonly<Record<string, string>>,
): Divergence[] =>
  REPORTED.flatMap((key) => {
    const kept = readEnv(existing, key)
    const offered = desired[key]
    return kept !== undefined && offered !== undefined && kept !== offered
      ? [{ key, kept, offered }]
      : []
  })

/** The Dispatch port the Target publishes, which an operator may have pinned
 *  in the environment file. Compose's own default is the fallback. */
export const harnessPort = (envContent: string): number => {
  const port = Number(readEnv(envContent, 'PORT'))
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3000
}

export const readEnvScript = (installDir: string): string =>
  `cat ${shellQuote(`${installDir}/.env`)} 2> /dev/null || true`

/**
 * Write the environment file and create the secrets directory.
 *
 * The content arrives on stdin, never in the script: it holds the agent's
 * credentials on every run after the first, and a script is an argument list
 * that other processes on the Target can read. Written beside the target and
 * moved into place so a failed write cannot leave a half-file where the
 * credentials were.
 */
export const writeEnvScript = (installDir: string): string => {
  const dir = shellQuote(installDir)
  const secrets = shellQuote(secretsDir(installDir))
  return `set -eu
umask 077
mkdir -p ${dir}
tmp="$(mktemp ${dir}/.env.XXXXXX)"
cat > "$tmp"
chmod 600 "$tmp"
mv "$tmp" ${dir}/.env
mkdir -p ${secrets}
chmod 700 ${secrets}`
}

export const composeScript = (installDir: string, args: string): string =>
  `cd ${shellQuote(installDir)} && docker compose ${args}`

/**
 * Put this content in the Target's environment file, or say why it could not
 * be. Both the install and the credential step write that file, and both must
 * send it the same way — over stdin, never in the script — so there is one
 * function rather than two copies to keep honest.
 */
export const writeTargetEnv = async (
  connector: Connector,
  installDir: string,
  content: string,
): Promise<void> => {
  const written = await connector.exec(writeEnvScript(installDir), { stdin: content })
  if (written.code !== 0) throw fail('Writing the environment file', written.code, written.stderr)
}

/** Everything the install needs of a Target. The prompter is not among them:
 *  install/upgrade asks nothing, which is what lets a re-run be idempotent. */
export interface InstallSession {
  readonly profile: TargetProfile
  readonly connector: Connector
}

/** One shape for "a command on the Target did not work", so the credential
 *  step and the install report a failed `exec` the same way. */
export const fail = (what: string, code: number, stderr: string): Error =>
  new Error(`${what} failed (exit ${code}): ${stderr.trim().split('\n').at(-1) ?? 'no output'}`)

/** Ship this package's own contents to the Target — the package *is* the
 *  Harness (ADR 0006), so this is the whole of "install the software". */
export const deliver = async (
  { profile, connector }: InstallSession,
  log: (line: string) => void,
): Promise<void> => {
  const version = await packageVersion()
  log(
    `\nDelivering @dworznik/sandcastle-vps ${version} to ${describeTarget(profile)} → ${profile.installDir}…`,
  )
  const { tarball, cleanup } = await packSelf()
  try {
    await connector.putTar(createReadStream(tarball), profile.installDir)
  } finally {
    await cleanup()
  }
}

/**
 * Everything after delivery: read the Target, write its environment, build and
 * start the stack, and check it from here. Returns the checks rather than
 * throwing on a failing one — a stack that is up and wrong is a different
 * situation from one that would not start, and the operator needs to see both.
 */
export const provision = async (
  { profile, connector }: InstallSession,
  log: (line: string) => void,
  verifyOptions: Partial<VerifyOptions> = {},
): Promise<Check[]> => {
  log('Reading the Target…')
  const probe = await connector.exec(FACTS_SCRIPT)
  if (probe.code !== 0 && probe.stdout.trim() === '') {
    throw fail('Reading the Target', probe.code, probe.stderr)
  }
  const facts = parseFacts(probe.stdout)

  const current = await connector.exec(readEnvScript(profile.installDir))
  const existing = current.stdout
  const desired = desiredEnv(profile, facts)
  for (const { key, kept, offered } of divergences(existing, desired)) {
    log(`  keeping ${key}=${kept} — this install would have written ${offered}`)
  }

  // Seed, never rotate: this is the whole of what makes a re-run idempotent
  // and an upgrade in place safe. An operator's edit and a captured credential
  // both survive it.
  const content = upsertAllEnv(existing, desired, 'seed')
  await writeTargetEnv(connector, profile.installDir, content)
  log(`Wrote ${profile.installDir}/.env (mode 600) and ${secretsDir(profile.installDir)}.`)

  // Before `up`: compose declares the network external and refuses to start
  // the stack until it exists. A no-op on a Target that already has it.
  const network = await connector.exec(ensureNetworkScript())
  if (network.code !== 0) {
    throw fail(`Creating the ${PLATFORM_NETWORK} network`, network.code, network.stderr)
  }

  log('\nBuilding the Harness image and starting the stack…')
  const up = await connector.exec(
    composeScript(profile.installDir, 'up -d --build --remove-orphans'),
  )
  if (up.code !== 0) throw fail('docker compose up', up.code, up.stderr)

  const port = harnessPort(content)
  log('\nChecking it from here…')
  const checks = await verifyInstall(connector, {
    installDir: profile.installDir,
    harnessPort: port,
    ...verifyOptions,
  })
  log(formatChecks(checks))

  const ps = await connector.exec(composeScript(profile.installDir, 'ps'))
  log(`\n${ps.stdout.trim()}`)
  log(nextSteps(profile, port, checks))
  return checks
}

/**
 * Install or upgrade in place: the whole of the menu's first action. Returns
 * whether every check passed.
 */
export const install = async (
  session: InstallSession,
  log: (line: string) => void = console.log,
): Promise<boolean> => {
  await deliver(session, log)
  const checks = await provision(session, log)
  return checks.every((check) => check.ok)
}

/** What to do next, which depends on what just happened. */
export const nextSteps = (
  profile: TargetProfile,
  port: number,
  checks: readonly Check[],
): string => {
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) {
    return [
      '',
      `The stack is up but ${failed.length === 1 ? 'a check' : `${failed.length} checks`} did not pass.`,
      `Its log:  ${composeScript(profile.installDir, 'logs --tail 40 harness')}`,
      '',
      'Nothing behind the Dispatch surface authenticates, so do not use a Target that is',
      'reachable off loopback until the exposure check passes.',
    ].join('\n')
  }
  return [
    '',
    'The stack is up. Its credentials come next — until the Harness holds them,',
    'every Run refuses to start and names what is missing.',
    '',
    `Dashboard: ssh -L 8288:127.0.0.1:8288 ${profile.host}, then open http://127.0.0.1:8288`,
    `Dispatch:  the Harness answers on the Target's 127.0.0.1:${port}`,
  ].join('\n')
}
