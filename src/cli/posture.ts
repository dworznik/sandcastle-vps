import { readEnv, upsertEnv } from './target-env.js'

/**
 * The two per-Target toggles of ADR 0010, `sessions` and `access`, both off
 * by default. They live in the Target's Local Config — the environment file
 * the stack reads — and never in the operator's profile: what a Target is
 * enabled for is a fact about the Target, and a profile that said otherwise
 * would be a profile that lies the moment a second machine reads it.
 *
 * In this slice the toggles record state and drive `status`; the slices that
 * attach session containers, the Memory service and the Access service to
 * them come later under #72. Recording the state first is what lets those
 * land in parallel without both inventing the toggle.
 *
 * Pure: the install seeds from here and `status` derives the posture from
 * here, and neither should have to import the menu flow (toggles.ts) to do it.
 */

export type Toggle = 'sessions' | 'access'
export const TOGGLES: readonly Toggle[] = ['sessions', 'access']

/** The key each toggle is stored under in the environment file. */
export const TOGGLE_KEY: Readonly<Record<Toggle, string>> = {
  sessions: 'SESSIONS_ENABLED',
  access: 'ACCESS_ENABLED',
}

export type Toggles = Readonly<Record<Toggle, boolean>>
export const OFF: Toggles = { sessions: false, access: false }

/** Only the literal this CLI writes turns a toggle on. Enabling sessions
 *  exposes the Docker socket to Project-built containers, and `yes` or `1` in
 *  a hand-edited file should not do that by accident. */
const ON = 'true'

export const readToggles = (envContent: string): Toggles => ({
  sessions: readEnv(envContent, TOGGLE_KEY.sessions) === ON,
  access: readEnv(envContent, TOGGLE_KEY.access) === ON,
})

/** Replace, never seed: the operator just chose the value. */
export const writeToggle = (envContent: string, toggle: Toggle, enabled: boolean): string =>
  upsertEnv(envContent, TOGGLE_KEY[toggle], enabled ? ON : 'false', 'rotate')

/** What the install seeds, so a fresh file names both toggles. Seeded, so an
 *  enabled toggle survives an upgrade like everything else in the file. */
export const seededToggles = (): Readonly<Record<string, string>> =>
  Object.fromEntries(TOGGLES.map((toggle) => [TOGGLE_KEY[toggle], 'false']))

/** The two postures of ADR 0007. `access` does not change the posture: a
 *  Run-only Target with its dashboard reachable from a phone is still a
 *  Run-only Target (ADR 0010). */
export type Posture = 'run-only' | 'workstation'

export const posture = (toggles: Toggles): Posture =>
  toggles.sessions ? 'workstation' : 'run-only'

const POSTURE_LABEL: Readonly<Record<Posture, string>> = {
  'run-only': 'Run-only Target',
  workstation: 'Workstation Target',
}

export const state = (enabled: boolean): string => (enabled ? 'on' : 'off')

export const describePosture = (toggles: Toggles): string =>
  `${POSTURE_LABEL[posture(toggles)]} — sessions ${state(toggles.sessions)}, access ${state(toggles.access)}`
