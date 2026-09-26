import { accessRefresh } from './access.js'
import type { Connector } from './connectors/types.js'
import { fail, harnessPort, readEnvScript } from './install.js'
import { MEMORY_SERVICE, memoryDown, memoryUp } from './memory.js'
import { parseProjects, projectsScript } from './onboard.js'
import { readToggles } from './posture.js'
import { parseProbe } from './preflight.js'
import type { TargetProfile } from './profiles.js'
import type { Prompter } from './prompt.js'
import {
  CLAUDE_VOLUME,
  attachScript,
  ensureClaudeVolumeScript,
  listScript,
  parseSessions,
  specFor,
  startScript,
  stopScript,
  writeSessionArtifacts,
} from './session-files.js'
import { probeInstall } from './status.js'

/** What the operator does once, inside any Session, on a fresh Workstation
 *  Target. Printed when sessions is enabled and kept in the README; the
 *  platform runs none of it and seeds nothing into `~/.claude` (ADR 0010). */
export const FIRST_TIME = [
  'First time on this Target, inside any Session:',
  '  claude auth login                          — one login serves every Session, and refreshes itself',
  '  claude plugin install claude-mem@thedotmack — the Memory service runs this plugin out of the volume',
  '  claude plugin install …                    — the other plugins you use; the image carries only skills',
  'Nothing is seeded into ~/.claude: what you set up there is yours.',
].join('\n')

/**
 * The `sessions` toggle's hook: enabling creates the shared login volume and
 * brings the Memory service up, since Memory travels with Sessions (ADR
 * 0010); disabling stops the service and keeps the volume and the store, so
 * the login and the observations are still there when sessions comes back.
 * Running Sessions are not stopped by disabling — stop is explicit, on the
 * Sessions menu — and the toggle only gates opening new ones.
 */
export const applySessions = async (
  { profile, connector }: { readonly profile: TargetProfile; readonly connector: Connector },
  enabled: boolean,
  log: Log = console.log,
): Promise<void> => {
  // The hook runs after the toggle is written, so the environment file this
  // reads already says what sessions is — and whether access is on, which
  // decides whether the Memory UI's allowlist entry has to follow (#94).
  const env = await connector.exec(readEnvScript(profile.installDir))
  if (env.code !== 0) throw fail('Reading the Target', env.code, env.stderr)

  if (!enabled) {
    await memoryDown(connector, profile.installDir)
    log(`\nThe Memory service is stopped; its store is kept.`)
    log(`The login volume ${CLAUDE_VOLUME} is kept, so a login survives sessions being off.`)
    log('Running Sessions keep running; stop them from the Sessions menu.')
    // After Memory is down: the UI leaves the allowlist with the toggle.
    await accessRefresh(connector, profile.installDir, env.stdout, log)
    return
  }
  const created = await connector.exec(ensureClaudeVolumeScript())
  if (created.code !== 0) {
    throw fail(`Creating the ${CLAUDE_VOLUME} volume`, created.code, created.stderr)
  }
  log(`\nThe shared login volume ${CLAUDE_VOLUME} is there, for every Session on ${profile.name}.`)
  await memoryUp(connector, profile.installDir, env.stdout, log)
  log(
    `The Memory service is up as \`${MEMORY_SERVICE}\` on the platform network; it waits for the` +
      '\nplugin below to be installed, and says so in its log until it is.',
  )
  // After Memory is up, so the proxy resolves on the platform network when
  // the Access entrypoint builds its rules.
  await accessRefresh(connector, profile.installDir, env.stdout, log)
  log(`\n${FIRST_TIME}`)
}

/**
 * The menu's "Sessions": the flow that opens a Session on a Project — start
 * it if it is not running, then attach — or stops one. What a Session is
 * made of is session-files.ts; this is the asking, the starting and the
 * attaching.
 */

export interface SessionsSession {
  readonly profile: TargetProfile
  readonly connector: Connector
  readonly prompter: Prompter
}

type Log = (line: string) => void

type Pick = { readonly open: string } | { readonly stop: string } | null

export interface SessionsOutcome {
  readonly opened?: string
  readonly stopped?: string
}

/**
 * Returns what it did, or `undefined` when it could not act — nothing
 * installed, sessions off, nothing chosen.
 */
export const sessionsMenu = async (
  { profile, connector, prompter }: SessionsSession,
  log: Log = console.log,
): Promise<SessionsOutcome | undefined> => {
  const { env, envContent, installed } = await probeInstall(connector, profile.installDir)
  if (env.code !== 0) throw fail('Reading the Target', env.code, env.stderr)
  if (!installed) {
    log('\nNothing is installed here. Run install/upgrade first.')
    return undefined
  }

  // The gate: a Session runs a Project's committed Dockerfile with the Docker
  // socket available, and the toggle is where the operator accepted that.
  if (!readToggles(envContent).sessions) {
    log('\nSessions are off on this Target — it is a Run-only Target.')
    log('Enable `sessions` from "Sessions and access" first; it says what that trusts.')
    return undefined
  }

  const [listed, running] = await Promise.all([
    connector.exec(projectsScript(profile.installDir, harnessPort(envContent))),
    connector.exec(listScript()),
  ])
  const projects = parseProjects(listed.stdout.trim() || listed.stderr.trim()).filter(
    (project) => project.onboarded,
  )
  const sessions = parseSessions(running.stdout)
  const isRunning = (name: string) => sessions.some((session) => session.project === name)

  if (projects.length === 0) {
    log('\nNo Onboarded Projects yet — add one from the menu, then open a Session on it.')
    return undefined
  }

  const picked = await prompter.select<Pick>('Sessions', [
    ...projects.map((project) => ({
      label: `Open ${project.name}${isRunning(project.name) ? ' — running, attaches' : ''}`,
      value: { open: project.name },
    })),
    ...sessions.map((session) => ({
      label: `Stop ${session.project} — ${session.status}`,
      value: { stop: session.project },
    })),
    { label: 'Back', value: null },
  ])
  if (picked === null) return undefined

  if ('stop' in picked) {
    const stopped = await connector.exec(stopScript(profile.installDir, picked.stop))
    if (stopped.code !== 0) throw fail('Stopping the Session', stopped.code, stopped.stderr)
    log(`\nStopped the Session on ${picked.stop}. Its tmux windows are gone with it.`)
    return { stopped: picked.stop }
  }

  const project = projects.find((candidate) => candidate.name === picked.open)
  if (!project) return undefined
  const spec = specFor(profile, envContent, project)
  // Regenerated on every open, which is also how a Project Onboarded before
  // Sessions existed gets its files.
  await writeSessionArtifacts(connector, spec)

  const started = await connector.exec(startScript(spec.installDir, spec.name, spec.imageName))
  const answer = parseProbe(started.stdout)
  if (answer.error) throw new Error(answer.error)
  if (started.code !== 0) throw fail('Starting the Session', started.code, started.stderr)
  log(
    answer.state === 'running'
      ? `\nAttaching to ${spec.name}…`
      : `\nStarted ${spec.name}. Attaching…`,
  )

  // Attach is a capability, not an obligation: a Connector without a
  // terminal says so, and the Session is up either way.
  if (!connector.attach) {
    log(`\nThis kind of Target (${connector.kind}) cannot attach a terminal from here.`)
    log('The Session is running; attach to it from a shell on the Target with:')
    log(`  ${attachScript(spec.name)}`)
    return { opened: spec.name }
  }
  const attach = connector.attach.bind(connector)
  const code = await prompter.suspended(() => attach(attachScript(spec.name)))
  log(
    code === 0
      ? `\nDetached. The Session on ${spec.name} keeps running; open it again to return.`
      : `\nThe attach ended with exit ${code}. The Session keeps running unless it was stopped.`,
  )
  return { opened: spec.name }
}
