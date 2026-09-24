import { describe, expect, it } from 'vitest'
import { GIT_ASKPASS_SCRIPT } from './delivery-ports.js'

// The token is named, never interpolated: a value on a command line reaches
// `ps` and any log that echoes a command. The same rule GIT_SETUP_COMMAND and
// the Onboarding scripts follow, which is why this asserts on the text.
describe('GIT_ASKPASS_SCRIPT', () => {
  it('reads the token from the environment', () => {
    expect(GIT_ASKPASS_SCRIPT).toContain('"$GH_TOKEN"')
  })

  it('answers the username prompt with the token-bearer name git expects', () => {
    expect(GIT_ASKPASS_SCRIPT).toContain('x-access-token')
  })

  // git distinguishes its two prompts only by the text it passes as $1, so a
  // script that answered both the same way would send the token as a username.
  it('tells the two prompts apart', () => {
    expect(GIT_ASKPASS_SCRIPT).toContain('case "$1" in')
  })
})
