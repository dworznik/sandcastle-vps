import type { Connector } from './connectors/types.js'
import { fail, readEnvScript, writeTargetEnv } from './install.js'
import {
  TOGGLES,
  describePosture,
  onOff,
  readToggles,
  writeToggle,
  type Toggle,
  type Toggles,
} from './posture.js'
import { parseProbe } from './preflight.js'
import type { TargetProfile } from './profiles.js'
import type { Prompter } from './prompt.js'
import { versionScript } from './status.js'

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
  // The same two probes `status` decides "installed" from, so the two cannot
  // disagree about a Target: both reads swallow a missing file and succeed,
  // so a non-zero exit is the connection itself, which is a different thing
  // to say than "not installed".
  const [version, current] = await Promise.all([
    connector.exec(versionScript(profile.installDir)),
    connector.exec(readEnvScript(profile.installDir)),
  ])
  if (current.code !== 0) throw fail('Reading the Target', current.code, current.stderr)
  const existing = current.stdout
  if (!parseProbe(version.stdout).version?.trim() && !existing.trim()) {
    log(
      '\nNothing is installed here — the install directory holds no package and no' +
        '\nenvironment file. Run install/upgrade first; the toggles live in what it writes.',
    )
    return undefined
  }

  const toggles = readToggles(existing)
  log(`\n${describePosture(toggles)}`)

  const picked = await prompter.select('Sessions and access', [
    ...TOGGLES.map((toggle) => ({
      label: `${toggle}: ${onOff(toggles[toggle])} — ${toggles[toggle] ? 'disable' : 'enable'} it`,
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

  const written = writeToggle(existing, picked, enabling)
  await writeTargetEnv(connector, profile.installDir, written)
  // Read back from what was written rather than assembled here, so what this
  // reports is what `status` will read.
  const updated = readToggles(written)
  log(`\n${picked} is now ${onOff(enabling)}. ${describePosture(updated)}`)
  return updated
}
