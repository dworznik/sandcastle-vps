import type { Connector } from './connectors/types.js'
import { parseUdpListeners, type Listener } from './listeners.js'
import { PLATFORM_NETWORK } from './network.js'
import { readToggles } from './posture.js'
import { shellQuote } from './shell.js'
import { readEnv } from './target-env.js'

/**
 * Access: a WireGuard VPN on the Target, provisioned and managed by the CLI,
 * with services reached over it by plain HTTP at the tunnel address
 * (ADR 0011). The service is its own compose project in the install
 * directory, joined to the platform network so it can resolve the stack by
 * service name, and everything it reads is a file this CLI wrote:
 *
 *   <installDir>/access/compose.yaml   the service, generated here
 *   <installDir>/access/allowlist      one `service:port` per Exposed Service
 *   <installDir>/access/peers.conf     one [Peer] section per Peer
 *
 * Exposure is an allowlist, not a bind. The entrypoint drops forwarding by
 * default and adds one DNAT rule per allowlisted service, so "exposed" means
 * "in the allowlist" and nothing becomes reachable by accident. The Dispatch
 * surface can never be listed: `expose` refuses it.
 *
 * This module is pure apart from `accessUp` and `accessDown`, which need only
 * a Connector; the flows that ask the operator questions are in
 * access-menu.ts, so the install can bring Access up on an upgrade without
 * importing a prompter.
 */

export const ACCESS_PROJECT = 'sandcastle-vps-access'
export const WIREGUARD_PORT = 51820
/** The tunnel: the server at .1, Peers from .2 up. Fixed rather than
 *  configurable — claude-tmux's choice, and the one thing a Peer config and
 *  the DNAT rules have to agree on. */
export const TUNNEL_SUBNET = '10.13.13.0/24'
export const TUNNEL_ADDRESS = '10.13.13.1'
const TUNNEL_PREFIX = '10.13.13.'

/** The keys in the Target's Local Config that Access reads. */
export const ENDPOINT_KEY = 'ACCESS_ENDPOINT'
export const PORT_KEY = 'ACCESS_PORT'

export const accessDir = (installDir: string): string => `${installDir}/access`

/** The UDP port published on the public interface — the operator may have
 *  pinned it in the environment file. */
export const accessPort = (envContent: string): number => {
  const port = Number(readEnv(envContent, PORT_KEY))
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : WIREGUARD_PORT
}

// ------------------------------------------------------------ exposed services

/** A service on the platform network a Peer may reach: its compose service
 *  name, the port it answers on there, and what to call it. */
export interface ExposedService {
  readonly label: string
  readonly service: string
  readonly port: number
}

/** Day one: the Orchestrator's dashboard. claude-mem's UI joins when the
 *  Memory service exists (#94). Adding one is an entry here, never a hand
 *  edit on the Target. */
export const EXPOSED_SERVICES: readonly ExposedService[] = [
  { label: 'Orchestrator dashboard', service: 'inngest', port: 8288 },
]

/** Never exposed, whatever the port: the Harness serves the Dispatch surface,
 *  which is keyless by design — reachability is its access control, and it is
 *  the one endpoint that does work on the operator's behalf rather than
 *  showing them things (ADR 0011). */
const NEVER_EXPOSED: readonly string[] = ['harness']

const SERVICE_NAME = /^[a-z][a-z0-9_-]*$/u

/**
 * The allowlist the entrypoint reads, from the list of what to expose.
 * Refuses rather than filters: an entry that names the Harness is a mistake
 * in this code, and silently dropping it would hide the mistake.
 */
export const expose = (services: readonly ExposedService[]): string => {
  for (const { service, port } of services) {
    if (NEVER_EXPOSED.includes(service)) {
      throw new Error(
        `The Dispatch surface (${service}:${port}) can never be exposed — nothing behind it authenticates.`,
      )
    }
    if (!SERVICE_NAME.test(service)) throw new Error(`Not a compose service name: ${service}`)
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      throw new Error(`Not a port: ${port} for ${service}`)
    }
  }
  return `${[
    '# Written by the creator CLI from its Exposed Service list (ADR 0011).',
    '# One service:port per line; the Access service DNATs each from the tunnel',
    '# address. Edits here are overwritten the next time Access is brought up.',
    ...services.map(({ service, port }) => `${service}:${port}`),
  ].join('\n')}\n`
}

/** Where a Peer reaches each Exposed Service, for the operator to read. */
export const exposedAt = (services: readonly ExposedService[] = EXPOSED_SERVICES): string[] =>
  services.map(({ label, port }) => `${label}: http://${TUNNEL_ADDRESS}:${port}`)

// ------------------------------------------------------------ compose project

/** A YAML scalar that survives any path the operator chose. JSON strings are
 *  valid YAML flow scalars, so this is `JSON.stringify`, named for why. */
const yaml = (value: string): string => JSON.stringify(value)

/**
 * The Access service's compose file. Generated rather than shipped so the
 * bind mounts can be absolute: the install directory is per-Target, and a
 * relative path in a compose file resolves against the file, which would tie
 * the file to where it happens to be.
 *
 * The named volume is what makes the server key survive a restart and an
 * upgrade: `down` keeps it, and only a `down -v` the CLI never runs would
 * remove it.
 */
export const accessCompose = (installDir: string, port: number): string => {
  const dir = accessDir(installDir)
  return `# The Access service (ADR 0011). Generated by the creator CLI when access is
# enabled or the Target is upgraded; do not edit, it is written over.
name: ${ACCESS_PROJECT}

services:
  access:
    build:
      context: ${yaml(`${installDir}/docker/access`)}
    # NET_ADMIN for the interface and the iptables rules; SYS_MODULE so wg-quick
    # can load the kernel module on a Target where it is not built in.
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    sysctls:
      - net.ipv4.ip_forward=1
    ports:
      # The one intended public listener on a Target with access enabled.
      # UDP, so the install's exposure check — which reads TCP listen tables —
      # is unchanged and still passes.
      - ${yaml(`${port}:${WIREGUARD_PORT}/udp`)}
    volumes:
      - access_keys:/etc/wireguard
      - ${yaml(`${dir}/peers.conf:/config/peers.conf:ro`)}
      - ${yaml(`${dir}/allowlist:/config/allowlist:ro`)}
    restart: unless-stopped

volumes:
  access_keys:

networks:
  # The platform network, so the allowlisted services resolve by name.
  default:
    name: ${PLATFORM_NETWORK}
    external: true
`
}

// --------------------------------------------------------------------- peers

/** One of the operator's devices, as recorded on the Target. The private key
 *  is not here and never was: it is shown or written once and not kept. */
export interface Peer {
  readonly name: string
  readonly publicKey: string
  /** Its tunnel address, without the /32. */
  readonly address: string
  /** ISO date, for the operator to recognise a device by. */
  readonly added: string
}

const PEER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u

export const validatePeerName = (name: string): string => {
  if (!PEER_NAME.test(name)) {
    throw new Error(
      `Invalid Peer name: "${name}". Use lowercase letters, digits and dashes — it names a config file.`,
    )
  }
  return name
}

/** A WireGuard key: 32 bytes, base64. Checked before a key goes into a file
 *  wg-quick will parse, because a stray line there takes the interface down. */
const WIREGUARD_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u

export const validateKey = (key: string, what: string): string => {
  const trimmed = key.trim()
  if (!WIREGUARD_KEY.test(trimmed)) throw new Error(`Not a WireGuard key (${what}): ${trimmed}`)
  return trimmed
}

/** One [Peer] section, headed by the comment the CLI reads it back from. */
export const renderPeer = ({ name, publicKey, address, added }: Peer): string =>
  `# peer: ${name}, added ${added}
[Peer]
PublicKey = ${publicKey}
AllowedIPs = ${address}/32
`

/**
 * Read the Peers back out of peers.conf. Only sections headed by the CLI's
 * own comment count: the file is the CLI's, and a section without the header
 * is one something else wrote, which is reported rather than guessed at.
 */
export const parsePeers = (content: string): Peer[] => {
  const peers: Peer[] = []
  let current: { name: string; added: string; publicKey?: string; address?: string } | undefined
  const finish = (): void => {
    if (!current) return
    if (!current.publicKey || !current.address) {
      throw new Error(`peers.conf: the section for ${current.name} is incomplete`)
    }
    peers.push({
      name: current.name,
      added: current.added,
      publicKey: current.publicKey,
      address: current.address,
    })
    current = undefined
  }
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    const header = /^# peer: ([^,]+), added (\S+)$/u.exec(line)
    if (header) {
      finish()
      current = { name: header[1] ?? '', added: header[2] ?? '' }
      continue
    }
    if (line === '[Peer]') {
      if (!current) throw new Error('peers.conf: a [Peer] section without the CLI’s header')
      continue
    }
    const setting = /^(\w+)\s*=\s*(.+)$/u.exec(line)
    if (!setting || !current) continue
    if (setting[1] === 'PublicKey') current.publicKey = setting[2]?.trim()
    if (setting[1] === 'AllowedIPs') current.address = setting[2]?.trim().replace(/\/32$/u, '')
  }
  finish()
  return peers
}

/** The lowest free address in the tunnel. .1 is the server. */
export const nextPeerAddress = (peers: readonly Peer[]): string => {
  const taken = new Set(peers.map((peer) => peer.address))
  for (let host = 2; host <= 254; host += 1) {
    const candidate = `${TUNNEL_PREFIX}${host}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('The tunnel has no free address left — revoke a Peer first.')
}

export interface PeerConfigInput {
  readonly privateKey: string
  readonly address: string
  readonly serverPublicKey: string
  /** The Target as the Peer reaches it: a public address, or whatever the
   *  operator supplied for a Target with none. */
  readonly endpoint: string
  readonly port: number
}

/**
 * The config a stock WireGuard client imports. AllowedIPs is the tunnel
 * subnet and nothing else: the Peer routes only what it reaches over Access,
 * and the device's other traffic is untouched.
 */
export const peerConfig = ({
  privateKey,
  address,
  serverPublicKey,
  endpoint,
  port,
}: PeerConfigInput): string => `[Interface]
PrivateKey = ${privateKey}
Address = ${address}/32

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${endpoint}:${port}
AllowedIPs = ${TUNNEL_SUBNET}
PersistentKeepalive = 25
`

/** A default for the endpoint from an ssh destination: `op@vps.example.com`
 *  and `vps.example.com:2222` both give `vps.example.com`. Only a default —
 *  an OrbStack machine name is not reachable from a phone. */
export const endpointFrom = (host: string): string => {
  const withoutUser = host.includes('@') ? (host.split('@').at(-1) ?? host) : host
  return withoutUser.replace(/:\d+$/u, '')
}

// ------------------------------------------------------------------- scripts

export const accessComposeScript = (installDir: string, args: string): string =>
  `cd ${shellQuote(accessDir(installDir))} && docker compose ${args}`

/**
 * Write one of the Access files from stdin. The same shape as the environment
 * file's writer: beside the target and moved into place, so a half-written
 * allowlist can never be what the entrypoint reads.
 */
export const writeAccessFileScript = (installDir: string, file: string): string => {
  const dir = shellQuote(accessDir(installDir))
  const target = shellQuote(`${accessDir(installDir)}/${file}`)
  return `set -eu
umask 077
mkdir -p ${dir}
tmp="$(mktemp ${dir}/.${file}.XXXXXX)"
cat > "$tmp"
chmod 600 "$tmp"
mv "$tmp" ${target}`
}

/** Create peers.conf empty if it is not there — a bind mount of a missing
 *  file would make Docker create a directory in its place — and leave it
 *  alone if it is. */
export const ensurePeersFileScript = (installDir: string): string => {
  const dir = shellQuote(accessDir(installDir))
  const file = shellQuote(`${accessDir(installDir)}/peers.conf`)
  return `set -eu
umask 077
mkdir -p ${dir}
[ -f ${file} ] || : > ${file}`
}

export const readPeersScript = (installDir: string): string =>
  `cat ${shellQuote(`${accessDir(installDir)}/peers.conf`)} 2> /dev/null || true`

/** Both UDP tables at once, with the marker the TCP reader splits on. */
export const UDP_LISTENERS_SCRIPT = `cat /proc/net/udp 2>/dev/null || true
printf '=====\\n'
cat /proc/net/udp6 2>/dev/null || true`

export const parseUdpTables = (stdout: string): Listener[] => {
  const [udp = '', udp6 = ''] = stdout.split('=====\n')
  return [...parseUdpListeners(udp), ...parseUdpListeners(udp6)]
}

/** The running service's state, one line, or nothing when it is not up. */
export const accessStateScript = (installDir: string): string =>
  `${accessComposeScript(installDir, "ps --format '{{.Service}}\\t{{.State}}'")} 2> /dev/null || true`

const failed = (what: string, code: number, stderr: string): Error =>
  new Error(`${what} failed (exit ${code}): ${stderr.trim().split('\n').at(-1) ?? 'no output'}`)

/**
 * Bring the Access service up, or up to date: write what it reads, then
 * build and start it. Idempotent, and asks nothing — the install runs this on
 * an upgrade of a Target with access enabled, and the install asks nothing.
 */
export const accessUp = async (
  connector: Connector,
  installDir: string,
  envContent: string,
  log: (line: string) => void,
): Promise<void> => {
  const port = accessPort(envContent)
  const files: [string, string][] = [
    ['compose.yaml', accessCompose(installDir, port)],
    ['allowlist', expose(EXPOSED_SERVICES)],
  ]
  for (const [file, content] of files) {
    const written = await connector.exec(writeAccessFileScript(installDir, file), {
      stdin: content,
    })
    if (written.code !== 0) throw failed(`Writing access/${file}`, written.code, written.stderr)
  }
  const peers = await connector.exec(ensurePeersFileScript(installDir))
  if (peers.code !== 0) throw failed('Creating access/peers.conf', peers.code, peers.stderr)

  log(`\nBuilding the Access image and starting WireGuard on udp/${port}…`)
  const up = await connector.exec(accessComposeScript(installDir, 'up -d --build'))
  if (up.code !== 0) throw failed('docker compose up (access)', up.code, up.stderr)
}

/** Stop the service. `down` without `-v`: the server key stays in its volume,
 *  so enabling access again brings the same identity back and existing Peer
 *  configs keep working. */
export const accessDown = async (connector: Connector, installDir: string): Promise<void> => {
  const down = await connector.exec(accessComposeScript(installDir, 'down'))
  if (down.code !== 0) throw failed('docker compose down (access)', down.code, down.stderr)
}

// -------------------------------------------------------------------- status

export interface AccessStatus {
  readonly enabled: boolean
  readonly endpoint?: string
  readonly port: number
  readonly peers: readonly Peer[]
  /** Why the Peers could not be read, when they could not. */
  readonly peersError?: string
  /** What `docker compose ps` said about the service; empty when it is not up. */
  readonly service: string
  /** Sockets bound on the WireGuard port, off loopback. */
  readonly listening: readonly Listener[]
}

export const ACCESS_OFF: AccessStatus = {
  enabled: false,
  port: WIREGUARD_PORT,
  peers: [],
  service: '',
  listening: [],
}

/** Read-only, like everything `status` does. */
export const gatherAccess = async (
  connector: Connector,
  installDir: string,
  envContent: string,
): Promise<AccessStatus> => {
  const enabled = readToggles(envContent).access
  const port = accessPort(envContent)
  const endpoint = readEnv(envContent, ENDPOINT_KEY)
  const [peersFile, state, udp] = await Promise.all([
    connector.exec(readPeersScript(installDir)),
    connector.exec(accessStateScript(installDir)),
    connector.exec(UDP_LISTENERS_SCRIPT),
  ])
  let peers: Peer[] = []
  let peersError: string | undefined
  try {
    peers = parsePeers(peersFile.stdout)
  } catch (error) {
    peersError = error instanceof Error ? error.message : String(error)
  }
  return {
    enabled,
    endpoint,
    port,
    peers,
    peersError,
    service: state.stdout.trim(),
    listening: parseUdpTables(udp.stdout).filter(
      (listener) => listener.port === port && !listener.loopback,
    ),
  }
}

/** The Access section of the status report. */
export const formatAccess = (status: AccessStatus): string[] => {
  if (!status.enabled) {
    const stale = status.service ? ' — but its service is still up; disable and enable access' : ''
    return [`  off${stale}`]
  }
  const lines: string[] = []
  const running = /\brunning\b/u.test(status.service)
  lines.push(
    running
      ? `  on          WireGuard running, Peers reach the Target at ${status.endpoint ?? '(no endpoint recorded)'}:${status.port}`
      : `  on          but the service is not running — disable and enable access to start it`,
  )
  lines.push(
    status.listening.length > 0
      ? `  udp/${String(status.port).padEnd(7)}listening on ${status.listening.map((l) => l.address).join(', ')} — the one intended public listener`
      : `  udp/${String(status.port).padEnd(7)}not listening`,
  )
  if (status.peersError) {
    lines.push(`  peers       could not be read: ${status.peersError}`)
  } else if (status.peers.length === 0) {
    lines.push('  peers       none yet — add one from the menu')
  } else {
    for (const peer of status.peers) {
      lines.push(`  ${peer.name.padEnd(12)}${peer.address}, added ${peer.added}`)
    }
  }
  for (const service of exposedAt()) lines.push(`  exposed     ${service}`)
  return lines
}
