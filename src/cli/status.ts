import type { Connector } from './connectors/types.js'
import { CREDENTIAL_LABEL, missing, type CredentialName } from './credentials.js'
import { composeScript, harnessPort, readEnvScript } from './install.js'
import { parseProjects, projectsScript, type RemoteProject } from './onboard.js'
import { packageVersion } from './package.js'
import { parseProbe } from './preflight.js'
import type { TargetProfile } from './profiles.js'
import { shellQuote } from './shell.js'
import {
  LISTENERS_SCRIPT,
  appsQueryScript,
  exposureCheck,
  parseBothTables,
  syncCheck,
  type Check,
} from './verify.js'

/**
 * What is actually running on this Target, and is it the version I have.
 *
 * Reads and never writes — that is the whole contract, and the reason it can
 * be run on a Target mid-Run without thinking about it. Every question is
 * asked of the thing that owns the answer: the Orchestrator for what synced,
 * the Harness for what Projects it can see, the Target's own kernel for what
 * is listening. Nothing is inferred from a file this CLI wrote earlier.
 */

/** The package version the Target is running, read out of the install
 *  directory. Parsed with sed rather than node: preflight asks a Target for
 *  Docker and nothing else, so there is no node on it to parse JSON with. */
export const versionScript = (installDir: string): string => {
  const manifest = shellQuote(`${installDir}/package.json`)
  return `set -u
if [ -f ${manifest} ]; then
  printf 'version\\t%s\\n' "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${manifest} | head -1)"
else
  printf 'version\\t\\n'
fi`
}

/** The images the Target's engine holds, so a Project with no image can be
 *  told apart from one whose build never ran. No `cd` into the install
 *  directory: this asks the engine, not a compose project, and `docker images`
 *  does not read a working directory. */
export const imagesScript = (): string => `docker images --format '{{.Repository}}:{{.Tag}}'`

export interface ProjectStatus extends RemoteProject {
  readonly imageBuilt: boolean
}

export interface StatusReport {
  readonly target: string
  /** False when the install directory holds no package at all — a Target this
   *  CLI has never installed to, which is a finding rather than a failure. */
  readonly installed: boolean
  /** Whether the Target answered at all. A Target that cannot be reached and
   *  one that has nothing installed look identical from the answers alone, and
   *  only one of them is fixed by running the install. */
  readonly reachable?: boolean
  readonly unreachableReason?: string
  readonly targetVersion?: string
  readonly cliVersion: string
  readonly containers: string
  /** The Orchestrator's sync, and the off-loopback check. */
  readonly checks: readonly Check[]
  readonly projects: readonly ProjectStatus[]
  /** Why the Projects could not be listed, when they could not. */
  readonly projectsError?: string
  readonly missingCredentials: readonly CredentialName[]
}

export interface StatusSession {
  readonly profile: TargetProfile
  readonly connector: Connector
}

/**
 * Ask the Target everything, in one pass.
 *
 * Nothing here throws for a failing answer: a Target worth running this
 * against is usually one where something is already wrong, and a report that
 * gives up at the first bad answer is a report that never reaches the part
 * that explains it.
 */
export const gatherStatus = async ({
  profile,
  connector,
}: StatusSession): Promise<StatusReport> => {
  const [version, env] = await Promise.all([
    connector.exec(versionScript(profile.installDir)),
    connector.exec(readEnvScript(profile.installDir)),
  ])
  const targetVersion = parseProbe(version.stdout).version?.trim()
  const envContent = env.stdout
  const cliVersion = await packageVersion()

  // Both probes answer for a Target that is reachable and bare — one prints an
  // empty version, the other `cat`s a file that is not there and succeeds
  // anyway. A *non-zero* exit is the connection itself failing, which is a
  // different thing to tell the operator than "nothing is installed".
  if (!targetVersion && !envContent.trim()) {
    const unreachable = version.code !== 0
    return {
      target: profile.name,
      installed: false,
      reachable: !unreachable,
      unreachableReason: unreachable
        ? version.stderr.trim().split('\n').at(-1) || `the check exited ${version.code}`
        : undefined,
      cliVersion,
      containers: '',
      checks: [],
      projects: [],
      missingCredentials: [],
    }
  }

  const port = harnessPort(envContent)
  const [ps, apps, listeners, projects, images] = await Promise.all([
    connector.exec(composeScript(profile.installDir, 'ps')),
    connector.exec(appsQueryScript(profile.installDir)),
    connector.exec(LISTENERS_SCRIPT),
    connector.exec(projectsScript(profile.installDir, port)),
    connector.exec(imagesScript()),
  ])

  const built = new Set(
    images.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )

  let listed: ProjectStatus[] = []
  let projectsError: string | undefined
  try {
    listed = parseProjects(projects.stdout.trim() || projects.stderr.trim()).map((project) => ({
      ...project,
      imageBuilt: built.has(project.imageName),
    }))
  } catch (error) {
    projectsError = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }

  return {
    target: profile.name,
    installed: true,
    targetVersion: targetVersion || undefined,
    cliVersion,
    containers: ps.stdout.trim(),
    checks: [
      syncCheck(apps.stdout.trim() || apps.stderr.trim()),
      exposureCheck(parseBothTables(listeners.stdout), port),
    ],
    projects: listed,
    projectsError,
    missingCredentials: missing(envContent),
  }
}

/** The report, as something to read. Pure, so what it says is testable
 *  without a Target. */
export const formatStatus = (report: StatusReport): string => {
  const lines: string[] = ['', `Target ${report.target}`]

  if (report.reachable === false) {
    return [
      ...lines,
      '',
      `The Target did not answer: ${report.unreachableReason ?? 'the connection failed'}`,
      'Nothing was read, so nothing below could be reported. This is a connection',
      'to fix, not an install to run.',
    ].join('\n')
  }

  if (!report.installed) {
    return [
      ...lines,
      '',
      'Nothing is installed here — the install directory holds no package and no',
      'environment file. Run install/upgrade to put the stack on it.',
      '',
      `This CLI is ${report.cliVersion}.`,
    ].join('\n')
  }

  // The version comparison is the question an operator came with often enough
  // that it goes first: a Target running something older than the CLI is the
  // usual explanation for "but I fixed that".
  lines.push('')
  if (!report.targetVersion) {
    lines.push(`  version     unknown on the Target; this CLI is ${report.cliVersion}`)
  } else if (report.targetVersion === report.cliVersion) {
    lines.push(`  version     ${report.targetVersion}, same as this CLI`)
  } else {
    lines.push(
      `  version     ${report.targetVersion} on the Target, ${report.cliVersion} here —` +
        ' run install/upgrade to bring it level',
    )
  }

  for (const check of report.checks) {
    lines.push(`  ${check.ok ? 'ok  ' : 'FAIL'}        ${check.label}: ${check.detail}`)
  }

  lines.push(
    '',
    report.missingCredentials.length === 0
      ? '  credentials all held'
      : `  credentials missing: ${report.missingCredentials
          .map((name) => CREDENTIAL_LABEL[name])
          .join(', ')} — a Run would refuse to start`,
  )

  lines.push('', 'Projects')
  if (report.projectsError) {
    lines.push(`  could not ask the Harness: ${report.projectsError}`)
  } else if (report.projects.length === 0) {
    lines.push('  none under the workspace root yet — add one from the menu.')
  } else {
    for (const project of report.projects) {
      const state = !project.onboarded
        ? 'a checkout, not Onboarded'
        : project.imageBuilt
          ? `Onboarded, ${project.imageName}`
          : `Onboarded, ${project.imageName} not built yet — the first Run builds it`
      lines.push(`  ${project.name.padEnd(24)}${state}`)
    }
  }

  lines.push('', 'Containers', report.containers || '  (none)')
  return lines.join('\n')
}

/** The menu's "Status": ask, print, change nothing. */
export const reportStatus = async (
  session: StatusSession,
  log: (line: string) => void = console.log,
): Promise<StatusReport> => {
  const report = await gatherStatus(session)
  log(formatStatus(report))
  return report
}
