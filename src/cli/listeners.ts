/**
 * What is listening on the Target, read from `/proc/net/tcp` and
 * `/proc/net/tcp6`.
 *
 * The retired deploy asked `ss` for this from inside the Target. Verification
 * is the CLI's job now, and `/proc` needs nothing installed: `ss` comes from
 * iproute2, which is not a dependency preflight checks for and not one worth
 * adding for a single command. Every Target that can run Docker Engine has
 * `/proc`.
 *
 * The parsing is here rather than in an awk script on the far side so that the
 * awkward half — little-endian hex addresses — is testable.
 */

export interface Listener {
  /** Human-readable, as the operator would recognise it: `0.0.0.0`, `::1`. */
  readonly address: string
  readonly port: number
  readonly loopback: boolean
}

/** `st` column for a socket in LISTEN. Everything else is a connection. */
const LISTEN = '0A'
/** A bound, unconnected UDP socket reports TCP_CLOSE — UDP has no LISTEN, and
 *  a socket in this state is one that will answer a datagram. */
const UDP_BOUND = '07'

/** Each 32-bit word of a `/proc/net` address is little-endian hex. */
const wordBytes = (word: string): number[] => {
  const bytes: number[] = []
  for (let i = 0; i < 8; i += 2) bytes.unshift(Number.parseInt(word.slice(i, i + 2), 16))
  return bytes
}

const hexToBytes = (hex: string): number[] => {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 8) bytes.push(...wordBytes(hex.slice(i, i + 8)))
  return bytes
}

const formatIpv4 = (bytes: readonly number[]): string => bytes.join('.')

/** Enough of RFC 5952 to be recognisable: `::`, `::1`, `::ffff:127.0.0.1`. */
const formatIpv6 = (bytes: readonly number[]): string => {
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${formatIpv4(bytes.slice(12))}`
  }
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2)
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16))

  let bestStart = -1
  let bestLength = 0
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] !== '0') continue
    let end = i
    while (end < groups.length && groups[end] === '0') end++
    if (end - i > bestLength) {
      bestStart = i
      bestLength = end - i
    }
    i = end
  }
  if (bestLength < 2) return groups.join(':')
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`
}

const isLoopback = (bytes: readonly number[]): boolean => {
  if (bytes.length === 4) return bytes[0] === 127
  // ::1, and the v4-mapped form a dual-stack listener on 127.0.0.1 shows up as.
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes[12] === 127
  }
  return false
}

/**
 * Read one `/proc/net/tcp` or `/proc/net/tcp6` table, keeping only the sockets
 * in LISTEN. Unparseable lines are skipped rather than guessed at — the header
 * row is one of them.
 */
export const parseListeners = (table: string): Listener[] => parseTable(table, LISTEN)

/** The same, for `/proc/net/udp` and `/proc/net/udp6`, where the WireGuard
 *  port of a Target with Access enabled is the one intended public listener. */
export const parseUdpListeners = (table: string): Listener[] => parseTable(table, UDP_BOUND)

const parseTable = (table: string, state: string): Listener[] => {
  const listeners: Listener[] = []
  for (const line of table.split('\n')) {
    const fields = line.trim().split(/\s+/)
    const local = fields[1]
    if (fields[3] !== state || local === undefined) continue
    const [hex, port] = local.split(':')
    if (hex === undefined || port === undefined) continue
    if (hex.length !== 8 && hex.length !== 32) continue
    const bytes = hexToBytes(hex)
    listeners.push({
      address: bytes.length === 4 ? formatIpv4(bytes) : formatIpv6(bytes),
      port: Number.parseInt(port, 16),
      loopback: isLoopback(bytes),
    })
  }
  return listeners
}

/**
 * The stack's own listeners that are reachable from off the Target.
 *
 * Scoped to the stack's ports on purpose: a Target legitimately answers on 22,
 * and a check that failed on sshd is a check the operator learns to ignore.
 * What must hold is that the Dispatch surface and the dashboard — both keyless,
 * so reachability *is* their access control — stay on loopback, and that
 * Inngest's connect gateway and gRPC ports, which bind every interface inside
 * their container and ignore `--host`, never appear on the Target at all.
 */
export const exposedListeners = (
  listeners: readonly Listener[],
  ports: readonly number[],
): Listener[] => listeners.filter((listener) => ports.includes(listener.port) && !listener.loopback)

/** Ports the stack must not expose, given where the Dispatch surface is. */
export const stackPorts = (harnessPort: number): number[] => [harnessPort, 8288, 8289, 50052, 50053]
