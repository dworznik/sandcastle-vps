import { writeFile } from 'node:fs/promises'
import {
  ENDPOINT_KEY,
  accessComposeScript,
  accessDown,
  accessPort,
  accessUp,
  describePeer,
  endpointFrom,
  exposedAt,
  nextPeerAddress,
  parsePeers,
  peerConfig,
  readPeersScript,
  removePeerScript,
  renderPeer,
  renderPeersFile,
  validateKey,
  validatePeerName,
  writeAccessFileScript,
  type Peer,
} from './access.js'
import type { Connector } from './connectors/types.js'
import { fail, readEnvScript, writeTargetEnv } from './install.js'
import { readToggles } from './posture.js'
import { parseProbe } from './preflight.js'
import type { TargetProfile } from './profiles.js'
import type { Choice, Prompter } from './prompt.js'
import { readEnv, upsertEnv } from './target-env.js'

/**
 * The parts of Access that ask the operator something: bringing it up when
 * the toggle is flipped, which needs the address Peers will reach the Target
 * at; adding a Peer, which needs a name and a choice of QR code or file; and
 * revoking one by name. What a Peer or the service is lives in access.ts.
 */

export interface AccessSession {
  readonly profile: TargetProfile
  readonly connector: Connector
  readonly prompter: Prompter
}

type Log = (line: string) => void

/**
 * What the `access` toggle does once its state is written: bring the service
 * up, or take it down. Asked for the endpoint the first time only — it is
 * seeded into the Target's Local Config, and an upgrade brings the service
 * back up without asking anything.
 */
export const applyAccess = async (
  { profile, connector, prompter }: AccessSession,
  enabled: boolean,
  log: Log = console.log,
): Promise<void> => {
  if (!enabled) {
    await accessDown(connector, profile.installDir)
    log(
      '\nWireGuard is stopped. The server key is kept, so Peer configs keep working if access is enabled again.',
    )
    return
  }

  const current = await connector.exec(readEnvScript(profile.installDir))
  if (current.code !== 0) throw fail('Reading the Target', current.code, current.stderr)
  let envContent = current.stdout

  if (!readEnv(envContent, ENDPOINT_KEY)) {
    log('\nPeers reach this Target at an address of their own — a public hostname or IP.')
    log('An OrbStack machine has none a phone can reach; give the address you use for it.')
    const endpoint = await prompter.text(
      'The address Peers reach this Target at',
      endpointFrom(profile.host),
    )
    envContent = upsertEnv(envContent, ENDPOINT_KEY, endpoint.trim(), 'seed')
    await writeTargetEnv(connector, profile.installDir, envContent)
  }

  await accessUp(connector, profile.installDir, envContent, log)
  log(`\nAccess is up: WireGuard on udp/${accessPort(envContent)}. Exposed over it:`)
  for (const service of exposedAt()) log(`  ${service}`)
  log('\nNext: add a Peer, from the menu.')
}

/**
 * The Target's environment, for a Peer action, or `undefined` — said, not
 * thrown — when access is off: every Peer action needs the service, and the
 * toggle is where the service comes from.
 */
const withAccessOn = async (
  connector: Connector,
  installDir: string,
  log: Log,
): Promise<string | undefined> => {
  const current = await connector.exec(readEnvScript(installDir))
  if (current.code !== 0) throw fail('Reading the Target', current.code, current.stderr)
  if (!readToggles(current.stdout).access) {
    log('\nAccess is off on this Target. Enable it first, from "Sessions and access".')
    return undefined
  }
  return current.stdout
}

/**
 * Generate a Peer's keypair and read the server's public key, all inside the
 * running Access container: the Target has `wg`, this machine need not. The
 * private key comes back on stdout and nowhere else — never in a script, and
 * never on a command line the Target's other processes could read.
 */
export const keypairScript = (installDir: string): string => `set -eu
${accessComposeScript(installDir, 'exec -T access sh -c \'k="$(wg genkey)"; printf "private\\t%s\\npublic\\t%s\\nserver\\t%s\\n" "$k" "$(printf %s "$k" | wg pubkey)" "$(wg show wg0 public-key)"\'')}`

export interface Keypair {
  readonly privateKey: string
  readonly publicKey: string
  readonly serverPublicKey: string
}

export const parseKeypair = (stdout: string): Keypair => {
  const fields = parseProbe(stdout)
  return {
    privateKey: validateKey(fields.private ?? '', "the Peer's private key"),
    publicKey: validateKey(fields.public ?? '', "the Peer's public key"),
    serverPublicKey: validateKey(fields.server ?? '', "the server's public key"),
  }
}

/** The config through qrencode, inside the Access container, so nothing has
 *  to be installed here. The config is on stdin. */
export const qrScript = (installDir: string): string =>
  accessComposeScript(installDir, 'exec -T access qrencode -t ansiutf8')

export interface AddPeerOptions {
  /** How a config file lands on this machine. Injected so the flow can be
   *  driven in a test; the wizard writes the file, mode 600. */
  readonly writeLocal?: (path: string, content: string) => Promise<void>
  /** Today's date, for the Peer record. */
  readonly today?: () => string
}

const writeLocalFile = (path: string, content: string): Promise<void> =>
  writeFile(path, content, { mode: 0o600 })

/**
 * The menu's "Add a Peer". Returns the Peer as recorded on the Target, or
 * `undefined` when nothing was added.
 *
 * The private key exists in three places for a moment — the container that
 * made it, this process, and the QR code or file — and in none afterwards:
 * the Target keeps the public half only, and the CLI keeps nothing.
 */
export const addPeer = async (
  { profile, connector, prompter }: AccessSession,
  log: Log = console.log,
  {
    writeLocal = writeLocalFile,
    today = () => new Date().toISOString().slice(0, 10),
  }: AddPeerOptions = {},
): Promise<Peer | undefined> => {
  const { installDir } = profile
  const envContent = await withAccessOn(connector, installDir, log)
  if (envContent === undefined) return undefined
  const endpoint = readEnv(envContent, ENDPOINT_KEY)
  if (!endpoint) {
    log('\nNo endpoint is recorded for this Target. Disable and enable access to set one.')
    return undefined
  }

  const existing = await connector.exec(readPeersScript(installDir))
  const peers = parsePeers(existing.stdout)
  const name = validatePeerName(await prompter.text('A name for the device', 'phone'))
  if (peers.some((peer) => peer.name === name)) {
    log(`\nA Peer called ${name} is already recorded. Pick another name.`)
    return undefined
  }

  const generated = await connector.exec(keypairScript(installDir))
  if (generated.code !== 0) {
    throw fail(
      'Generating the keypair (is the Access service running? disable and enable access)',
      generated.code,
      generated.stderr,
    )
  }
  const keys = parseKeypair(generated.stdout)
  const peer: Peer = {
    name,
    publicKey: keys.publicKey,
    address: nextPeerAddress(peers),
    added: today(),
  }

  // The record first, then the service picks it up: a restart re-reads
  // peers.conf and rebuilds the interface, and the tunnels in flight
  // reconnect on their next keepalive.
  const written = await connector.exec(writeAccessFileScript(installDir, 'peers.conf'), {
    stdin: `${existing.stdout.trimEnd()}${existing.stdout.trim() ? '\n\n' : ''}${renderPeer(peer)}`,
  })
  if (written.code !== 0) throw fail('Recording the Peer', written.code, written.stderr)
  const restarted = await connector.exec(accessComposeScript(installDir, 'restart access'))
  if (restarted.code !== 0)
    throw fail('Restarting the Access service', restarted.code, restarted.stderr)

  const config = peerConfig({
    privateKey: keys.privateKey,
    address: peer.address,
    serverPublicKey: keys.serverPublicKey,
    endpoint,
    port: accessPort(envContent),
  })

  const how = await prompter.select(`How will ${name} get its config?`, [
    { label: 'QR code — scan it from the WireGuard app on a phone', value: 'qr' as const },
    { label: 'Config file — import it into WireGuard on a laptop', value: 'file' as const },
  ])
  if (how === 'qr') {
    const qr = await connector.exec(qrScript(installDir), { stdin: config })
    if (qr.code !== 0) throw fail('Rendering the QR code', qr.code, qr.stderr)
    log(
      `\nScan this from the WireGuard app. It is shown once; the key is not kept.\n\n${qr.stdout}`,
    )
  } else {
    const path = await prompter.text('Write the config to', `./${profile.name}-${name}.conf`)
    await writeLocal(path, config)
    log(
      `\nWrote ${path} (mode 600). Import it into WireGuard, then delete it; the key is not kept.`,
    )
  }

  log(`\n${name} is ${peer.address} on the tunnel. Once connected, reach:`)
  for (const service of exposedAt()) log(`  ${service}`)
  return peer
}

/**
 * The menu's "Revoke a Peer". Returns the Peer that was revoked, or
 * `undefined` when nothing was changed.
 *
 * The record first, then the interface: the record is what the interface is
 * rebuilt from on its next start, so once the Peer is out of it the
 * revocation holds whatever happens next. Dropping it from the running
 * interface is what makes it immediate, and it is done with `wg set` rather
 * than a restart so the other Peers' tunnels are not touched.
 */
export const revokePeer = async (
  { profile, connector, prompter }: AccessSession,
  log: Log = console.log,
): Promise<Peer | undefined> => {
  const { installDir } = profile
  if ((await withAccessOn(connector, installDir, log)) === undefined) return undefined

  const existing = await connector.exec(readPeersScript(installDir))
  const peers = parsePeers(existing.stdout)
  if (peers.length === 0) {
    log('\nNo Peers are recorded on this Target. Nothing to revoke.')
    return undefined
  }
  log('\nPeers on this Target:')
  for (const peer of peers) log(describePeer(peer))

  const name = (await prompter.text('Which Peer should be revoked? (its name)')).trim()
  const peer = peers.find((candidate) => candidate.name === name)
  if (!peer) {
    log(`\nNo Peer called ${name} is recorded. Nothing was changed.`)
    return undefined
  }

  const written = await connector.exec(writeAccessFileScript(installDir, 'peers.conf'), {
    stdin: renderPeersFile(peers.filter((candidate) => candidate !== peer)),
  })
  if (written.code !== 0) throw fail('Rewriting the Peer record', written.code, written.stderr)

  const removed = await connector.exec(removePeerScript(installDir, peer.publicKey))
  if (removed.code === 0) {
    log(`\n${name} is revoked: dropped from the interface, and its config no longer connects.`)
  } else {
    // Out of the record is revoked: the interface is built from the record on
    // its next start, so the Peer is never admitted again. Said, not failed —
    // there was nothing connected to drop.
    log(
      `\n${name} is removed from the record, but the Access service is not running, so there` +
        '\nwas no live interface to drop it from. It will not be admitted when the service starts.',
    )
  }
  return peer
}

/** The menu's "Access": the Peer actions, under one entry. */
export const accessMenu = async (session: AccessSession, log: Log = console.log): Promise<void> => {
  const actions: Choice<'add' | 'revoke' | null>[] = [
    { label: 'Add a Peer', value: 'add' },
    { label: 'Revoke a Peer', value: 'revoke' },
    { label: 'Back', value: null },
  ]
  const action = await session.prompter.select('Access', actions)
  if (action === 'add') await addPeer(session, log)
  if (action === 'revoke') await revokePeer(session, log)
}
