import type { Connector, ConnectorDefinition, ConnectorKind } from './types.js'
import { sshDefinition } from './ssh.js'

/**
 * Every kind of Target the wizard knows about, built or not. This list is the
 * only place a kind is named: the wizard reads labels and address prompts from
 * it, so building one of the deferred Connectors means writing its module and
 * replacing its entry here — and touching nothing else.
 */
const filed = (kind: ConnectorKind, what: string, issue: number): ConnectorDefinition => ({
  kind,
  label: `${what} — not built yet (#${issue})`,
  addressLabel: '',
  issue,
  create: () => {
    throw new Error(`The Connector for ${what} is not built yet — see issue #${issue}.`)
  },
})

export const CONNECTORS: readonly ConnectorDefinition[] = [
  sshDefinition,
  filed('orb', 'an OrbStack machine', 27),
  filed('docker-desktop', 'Docker Desktop on this machine', 28),
  filed('docker-context', 'a remote engine over a docker context', 29),
]

export const definitionFor = (kind: ConnectorKind): ConnectorDefinition => {
  const definition = CONNECTORS.find((candidate) => candidate.kind === kind)
  if (!definition) throw new Error(`Unknown Connector kind: ${kind}`)
  return definition
}

export const connectorFor = (target: {
  readonly connector: ConnectorKind
  readonly host: string
  readonly installDir: string
  readonly workspaceRoot: string
}): Connector => definitionFor(target.connector).create(target)
