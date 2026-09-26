import { describe, expect, it } from 'vitest'
import {
  OFF,
  TOGGLE_KEY,
  describePosture,
  posture,
  readToggles,
  seededToggles,
  writeToggle,
} from './posture.js'
import { readEnv } from './target-env.js'

const INSTALLED = [
  'WORKSPACE_ROOT=/home/op/work',
  'SESSIONS_ENABLED=false',
  'ACCESS_ENABLED=false',
  '',
].join('\n')

describe('readToggles', () => {
  // A fresh install, and an install from before the toggles existed, both
  // read as off: nothing is enabled by the absence of a line.
  it('reads both off when the file says nothing about them', () => {
    expect(readToggles('')).toEqual(OFF)
    expect(readToggles('WORKSPACE_ROOT=/home/op/work\n')).toEqual(OFF)
  })

  it('reads each toggle independently', () => {
    expect(readToggles('SESSIONS_ENABLED=true\n')).toEqual({ sessions: true, access: false })
    expect(readToggles('ACCESS_ENABLED=true\n')).toEqual({ sessions: false, access: true })
  })

  // Only the value this CLI writes turns a toggle on. A Docker socket exposed
  // by `SESSIONS_ENABLED=yes` in a hand-edited file would be a socket exposed
  // by a typo.
  it.each(['false', 'yes', '1', 'on', 'TRUE', ''])('reads SESSIONS_ENABLED=%s as off', (value) => {
    expect(readToggles(`SESSIONS_ENABLED=${value}\n`).sessions).toBe(false)
  })
})

describe('writeToggle', () => {
  it('round-trips through the Local Config, leaving every other line alone', () => {
    const on = writeToggle(INSTALLED, 'sessions', true)
    expect(readToggles(on)).toEqual({ sessions: true, access: false })
    expect(readEnv(on, 'WORKSPACE_ROOT')).toBe('/home/op/work')
    expect(readToggles(writeToggle(on, 'sessions', false))).toEqual(OFF)
  })

  it('adds the line to a file from before the toggles existed', () => {
    expect(readToggles(writeToggle('WORKSPACE_ROOT=/x\n', 'access', true)).access).toBe(true)
  })
})

describe('seededToggles', () => {
  // The install seeds them off so the file names them; seed mode is what
  // keeps an enabled one enabled across an upgrade.
  it('names both toggles, off', () => {
    expect(seededToggles()).toEqual({ SESSIONS_ENABLED: 'false', ACCESS_ENABLED: 'false' })
    expect(Object.keys(seededToggles())).toEqual(Object.values(TOGGLE_KEY))
  })
})

describe('posture', () => {
  it('is Run-only until sessions is on', () => {
    expect(posture(OFF)).toBe('run-only')
    expect(posture({ sessions: false, access: true })).toBe('run-only')
  })

  it('is Workstation when sessions is on, whatever access is', () => {
    expect(posture({ sessions: true, access: false })).toBe('workstation')
    expect(posture({ sessions: true, access: true })).toBe('workstation')
  })

  it('names the posture and the state of each toggle', () => {
    expect(describePosture(OFF)).toBe('Run-only Target — sessions off, access off')
    expect(describePosture({ sessions: true, access: false })).toBe(
      'Workstation Target — sessions on, access off',
    )
    expect(describePosture({ sessions: false, access: true })).toBe(
      'Run-only Target — sessions off, access on',
    )
  })
})
