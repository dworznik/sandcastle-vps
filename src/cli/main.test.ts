import { describe, expect, it } from 'vitest'
import type { CaptureResult } from './credentials.js'
import { afterCredentials } from './main.js'
import type { TargetProfile } from './profiles.js'
import type { Check } from './verify.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const result = (overrides: Partial<CaptureResult> = {}): CaptureResult => ({
  complete: true,
  registered: true,
  checks: [],
  ...overrides,
})

const failing: Check[] = [{ ok: false, label: 'Harness synced', detail: 'no answer' }]

describe('afterCredentials', () => {
  it('sends the operator on to the next step when the Target is ready', () => {
    expect(afterCredentials(profile, result())).toContain('add a Project')
  })

  // The reason the three answers are reported apart. A Harness that did not
  // come back from its restart is not a Target to go and add a Project to, and
  // the useful thing to say is where its log is — not "you are all set".
  it('points at the log rather than the next step when a check did not pass', () => {
    const said = afterCredentials(profile, result({ checks: failing }))
    expect(said).not.toContain('add a Project')
    expect(said).toContain('did not pass')
    expect(said).toContain('logs --tail 40 harness')
  })

  it('says to re-run when a credential was not captured', () => {
    const said = afterCredentials(profile, result({ complete: false }))
    expect(said).toContain('Re-run install/upgrade')
    expect(said).not.toContain('add a Project')
  })

  // Distinct from the one above: everything is captured and the stack is fine,
  // but commits will push and show as unverified until the key is registered —
  // a web page to revisit, not a capture to redo.
  it('says what an unregistered signing key will cost, not that capture failed', () => {
    const said = afterCredentials(profile, result({ registered: false }))
    expect(said).toContain('unverified')
    expect(said).not.toContain('add a Project')
  })

  // A failed check outranks both: it is the one that stops a Dispatch working
  // at all, so it is what the operator should be reading about.
  it('reports the failed check first when more than one thing is wrong', () => {
    const said = afterCredentials(profile, result({ registered: false, checks: failing }))
    expect(said).toContain('logs --tail 40 harness')
  })
})
