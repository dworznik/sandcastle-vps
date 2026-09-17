import { HELP, parseArgs } from './args.js'
import { CONNECTORS, connectorFor } from './connectors/index.js'
import type { Connector, Preflight, PreflightCheck } from './connectors/types.js'
import { captureCredentials, type CaptureResult } from './credentials.js'
import { composeScript, install } from './install.js'
import { localShell, type LocalShell } from './local.js'
import { addProject } from './onboard.js'
import { packageVersion } from './package.js'
import { formatPreflight, remedyCommand } from './preflight.js'
import { createPrompter, type Prompter } from './prompt.js'
import {
  describeTarget,
  listTargets,
  readTarget,
  targetsDir,
  validateTargetName,
  writeTarget,
  type TargetProfile,
} from './profiles.js'

/** What is filed but not built, so a menu entry can say so precisely. */
const notBuiltYet = (what: string, issue: number): string =>
  `${what} is not built yet — see issue #${issue}.`

/** One Target, the way to reach it, the operator answering questions, and the
 *  machine they are answering on. These travel everywhere together. */
interface Session {
  readonly profile: TargetProfile
  readonly connector: Connector
  readonly prompter: Prompter
  readonly local: LocalShell
}

/** A failing check the wizard can actually offer to fix. */
type Fixable = PreflightCheck & { readonly remedy: string }
const isFixable = (check: PreflightCheck): check is Fixable =>
  !check.ok && check.remedy !== undefined

/**
 * Create a Target profile. The Target is asked for its own home directory
 * rather than `~` being written into the profile: the paths in a profile are
 * handed to a shell inside a quoted script on the far side, where `~` is just
 * a character.
 */
const createTarget = async (prompter: Prompter): Promise<TargetProfile> => {
  const name = validateTargetName(await prompter.text('A short name for this Target', 'vps'))
  const definition = await prompter.select(
    'How is it reached?',
    CONNECTORS.map((candidate) => ({ label: candidate.label, value: candidate })),
  )
  if (definition.issue !== undefined) {
    throw new Error(
      `${definition.label.split(' — ')[0]} is not built yet — see issue #${definition.issue}.`,
    )
  }

  const host = await prompter.text(definition.addressLabel)

  // installDir and workspaceRoot are only read once the Target is being worked
  // on, and the one command below reads neither — any value does for it.
  const { code, stdout, stderr } = await definition
    .create({ host, installDir: '/', workspaceRoot: '/' })
    .exec('printf "%s" "$HOME"')
  if (code !== 0 || !stdout.startsWith('/')) {
    throw new Error(`Could not reach the Target: ${stderr.trim() || `the check exited ${code}`}`)
  }
  const home = stdout.trim()

  const profile: TargetProfile = {
    name,
    connector: definition.kind,
    host,
    installDir: await prompter.text(
      'Where should the stack be installed?',
      `${home}/.sandcastle-vps`,
    ),
    workspaceRoot: await prompter.text('Where do the Project checkouts live?', `${home}/work`),
  }
  await writeTarget(profile)
  console.log(`\nSaved ${targetsDir()}/${name}.json — it holds no secrets, and never will.`)
  return profile
}

const chooseTarget = async (prompter: Prompter, wanted?: string): Promise<TargetProfile> => {
  if (wanted) return readTarget(wanted)
  const names = await listTargets()
  if (names.length === 0) {
    console.log("No Targets yet. Let's describe one.")
    return createTarget(prompter)
  }
  const choice = await prompter.select('Which Target?', [
    ...names.map((name) => ({ label: name, value: name })),
    { label: 'a new one…', value: null },
  ])
  return choice === null ? createTarget(prompter) : readTarget(choice)
}

/**
 * How many times to offer remedies before giving up. Two is the real depth —
 * install Docker, then join its group — and the third is slack for a Connector
 * whose checks reveal more than one layer.
 */
const REMEDY_PASSES = 3

/** Run the checks and show them; offer to fix what can be fixed from here. */
const checkTarget = async ({ profile, connector, prompter }: Session): Promise<Preflight> => {
  console.log(`\nChecking the Target (${describeTarget(profile)})…`)
  let preflight = await connector.preflight()
  console.log(formatPreflight(preflight))

  // Remedies cascade: on a bare Target the docker-group check cannot even run
  // until Docker exists, so installing Docker is what reveals it. One pass of
  // fixes would print that newly-revealed failure without ever offering it,
  // and a bare Target would need two invocations to install. Bounded, so a
  // remedy that never takes cannot spin.
  for (let pass = 0; pass < REMEDY_PASSES && !preflight.ok; pass += 1) {
    const fixable = preflight.checks.filter(isFixable)
    if (fixable.length === 0) return preflight
    if (!preflight.canElevate) {
      console.log(
        '\nRun the commands above on the Target yourself — elevation here needs a password.',
      )
      return preflight
    }
    if (
      !(await prompter.confirm(
        `\nRun ${fixable.length === 1 ? 'that' : 'those'} on the Target now?`,
      ))
    ) {
      return preflight
    }

    for (const check of fixable) {
      console.log(`\n  ${remedyCommand(check)}`)
      const { code, stderr } = await connector.exec(check.remedy, { sudo: true })
      if (code !== 0) {
        console.log(`  failed (exit ${code}): ${stderr.trim().split('\n').at(-1) ?? ''}`)
      }
    }

    console.log('\nRe-checking…')
    preflight = await connector.preflight()
    console.log(formatPreflight(preflight))
  }
  return preflight
}

/**
 * The package is what gets installed, so delivery is the CLI shipping its own
 * contents (ADR 0006), and the install is delivery plus everything that has to
 * be true afterwards.
 */
const installUpgrade = async (session: Session): Promise<void> => {
  const preflight = await checkTarget(session)
  if (!preflight.ok) {
    console.log('\nThe Target is not ready. Nothing was delivered.')
    return
  }
  // Credentials only follow a stack that came up and checked out. Capturing
  // them into a Target whose Harness is not answering would walk the operator
  // through two GitHub pages to reach a restart that cannot fix anything —
  // and `install` has already printed what to look at instead.
  if (!(await install(session))) return

  console.log(afterCredentials(session.profile, await captureCredentials(session)))
}

/**
 * What to say once the credential step is done. Three ways it can fall short
 * and a different move for each — telling an operator to go and add a Project
 * to a Target whose Harness stopped answering is how the next half hour gets
 * spent in the wrong place.
 */
export const afterCredentials = (
  profile: TargetProfile,
  { complete, registered, checks }: CaptureResult,
): string => {
  const failed = checks.filter((check) => !check.ok)
  if (failed.length > 0) {
    return (
      `\nThe Harness restarted with its credentials, but ${failed.length === 1 ? 'a check' : `${failed.length} checks`} did not pass.` +
      `\nIts log:  ${composeScript(profile.installDir, 'logs --tail 40 harness')}`
    )
  }
  if (!complete) {
    return (
      '\nThe Harness is short of a working identity — a Run will name what is missing.' +
      '\nRe-run install/upgrade to finish capturing it.'
    )
  }
  if (!registered) {
    return (
      '\nThe credentials are in place, but the signing key is not registered on GitHub.' +
      '\nRuns will commit and push; their commits will show as unverified until it is.' +
      '\nRe-run install/upgrade to finish registering it.'
    )
  }
  return '\nNext: add a Project, from the menu.'
}

const menu = async (session: Session): Promise<void> => {
  const { profile, prompter } = session
  for (;;) {
    const action = await prompter.select(`Target ${profile.name} (${describeTarget(profile)})`, [
      { label: 'Install / upgrade', value: 'install' as const },
      { label: 'Add a Project', value: 'project' as const },
      { label: 'Rotate credentials', value: 'rotate' as const },
      { label: 'Status', value: 'status' as const },
      { label: 'Quit', value: 'quit' as const },
    ])
    if (action === 'quit') return
    if (action === 'install') await installUpgrade(session)
    if (action === 'project') await addProject(session)
    if (action === 'rotate') {
      // Capture and rotation are the same walk over the same questions, and
      // differ only in which of them are asked and whether an existing value
      // is overwritten. Install/upgrade already asks for whatever is missing;
      // what is left for #37 is choosing a subset and replacing what is there.
      console.log(
        `\n${notBuiltYet('Choosing which credentials to replace', 37)}\n` +
          'Install / upgrade captures whichever the Target does not hold yet.',
      )
    }
    if (action === 'status') console.log(`\n${notBuiltYet('Status', 37)}`)
  }
}

export const runCli = async (argv: readonly string[]): Promise<number> => {
  let prompter: Prompter | undefined
  try {
    const args = parseArgs(argv)
    if (args.help) {
      console.log(HELP)
      return 0
    }
    console.log(`sandcastle-vps ${await packageVersion()}`)
    prompter = createPrompter()
    const profile = await chooseTarget(prompter, args.target)
    await menu({ profile, connector: connectorFor(profile), prompter, local: localShell() })
    return 0
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    prompter?.close()
  }
}
