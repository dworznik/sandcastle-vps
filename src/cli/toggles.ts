import type { Connector } from './connectors/types.js'
import { fail, readEnvScript, writeTargetEnv } from './install.js'
import {
  TOGGLES,
  describePosture,
  readToggles,
  state,
  writeToggle,
  type Toggle,
  type Toggles,
} from './posture.js'
import type { TargetProfile } from './profiles.js'
import type { Prompter } from './prompt.js'

/**
 * The menu's "Sessions and access": the flow that flips one of the two
 * toggles of ADR 0010. What a toggle is, and what it means for the Target's
 * posture, is posture.ts; this is only the asking and the writing.
 */

/** ADR 0007's rule, printed before sessions can be enabled. */
export const TRUST_RULE = [
  'A Project you open a Session on is a Project you trust with your Target.',
  'Its committed Dockerfile runs with the Docker socket available, which is',
  'root-equivalent on the Target. A Sandbox has no socket, so Onboarding a',
  'repository you do not control is fine for Runs and is not fine for Sessions.',
].join('\n')

export interface ToggleSession {
  readonly profile: TargetProfile
  readonly connector: Connector
  readonly prompter: Prompter
}

type Log = (line: string) => void

/**
 * The menu's "Sessions and access": show both toggles, flip one. Returns the
 * Target's toggles afterwards, or `undefined` when the Target has nothing
 * installed and there was nothing to flip.
 */
export const toggleFromMenu = async (
  { profile, connector, prompter }: ToggleSession,
  log: Log = console.log,
): Promise<Toggles | undefined> => {
  const current = await connector.exec(readEnvScript(profile.installDir))
  // The read swallows a missing file and succeeds; a non-zero exit is the
  // connection itself, which is a different thing to say than "not installed".
  if (current.code !== 0) throw fail('Reading the Target', current.code, current.stderr)
  const existing = current.stdout
  if (!existing.trim()) {
    log(
      '\nNothing is installed here — the install directory holds no environment file.' +
        '\nRun install/upgrade first; the toggles live in what it writes.',
    )
    return undefined
  }

  const toggles = readToggles(existing)
  log(`\n${describePosture(toggles)}`)

  const picked = await prompter.select('Sessions and access', [
    ...TOGGLES.map((toggle) => ({
      label: `${toggle}: ${state(toggles[toggle])} — ${toggles[toggle] ? 'disable' : 'enable'} it`,
      value: toggle as Toggle | null,
    })),
    { label: 'Back', value: null },
  ])
  if (picked === null) return toggles

  const enabling = !toggles[picked]
  if (picked === 'sessions' && enabling) {
    log(`\n${TRUST_RULE}`)
    if (!(await prompter.confirm('\nEnable sessions on this Target?'))) {
      log('\nLeft off. Nothing was changed.')
      return toggles
    }
  }

  await writeTargetEnv(connector, profile.installDir, writeToggle(existing, picked, enabling))
  const updated = { ...toggles, [picked]: enabling }
  log(`\n${picked} is now ${state(enabling)}. ${describePosture(updated)}`)
  return updated
}
