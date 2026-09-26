import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  PLATFORM_NETWORK,
  ensureNetworkScript,
  networkScript,
  parseNetwork,
  retireDefaultNetworkScript,
} from './network.js'

describe('PLATFORM_NETWORK', () => {
  // The install creates the network and compose joins it by name. The name
  // exists in both places, so this is the check that they cannot drift.
  it('is the network compose.yaml declares as external', async () => {
    const compose = await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8')
    expect(compose).toMatch(new RegExp(`name: ${PLATFORM_NETWORK}\\n\\s+external: true`, 'u'))
  })
})

describe('ensureNetworkScript', () => {
  it('creates the network only when it is not already there', () => {
    const script = ensureNetworkScript()
    expect(script).toContain(`docker network inspect ${PLATFORM_NETWORK}`)
    expect(script).toContain(`|| docker network create ${PLATFORM_NETWORK}`)
  })
})

describe('retireDefaultNetworkScript', () => {
  // A Target installed before the platform network still has the network
  // compose made for the stack. Compose moves the containers off it on `up`
  // and never removes it; the install does, and ignores it being gone.
  it('removes the network compose used to create, and tolerates its absence', () => {
    const script = retireDefaultNetworkScript()
    expect(script).toContain(`docker network rm ${PLATFORM_NETWORK}_default`)
    expect(script).toContain('|| true')
  })
})

describe('parseNetwork', () => {
  it('reads the driver and who is attached', () => {
    expect(
      parseNetwork(
        `${PLATFORM_NETWORK}\tbridge\tsandcastle-vps-harness-1\tsandcastle-vps-inngest-1\n`,
      ),
    ).toEqual({
      present: true,
      driver: 'bridge',
      attached: ['sandcastle-vps-harness-1', 'sandcastle-vps-inngest-1'],
    })
  })

  it('reads a network nothing has joined yet', () => {
    expect(parseNetwork(`${PLATFORM_NETWORK}\tbridge\n`)).toEqual({
      present: true,
      driver: 'bridge',
      attached: [],
    })
  })

  // An install that predates the network answers nothing, and the report has
  // to say so rather than showing an empty line.
  it('reports absence when the Target printed nothing', () => {
    expect(parseNetwork('')).toEqual({ present: false, attached: [] })
    expect(parseNetwork('\n')).toEqual({ present: false, attached: [] })
  })
})

describe('networkScript', () => {
  it('reads and never creates', () => {
    expect(networkScript()).toContain('docker network inspect')
    expect(networkScript()).not.toContain('create')
  })

  it('answers nothing, and succeeds, when the network is not there', () => {
    expect(networkScript()).toContain('|| true')
  })
})
