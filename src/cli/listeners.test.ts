import { describe, expect, it } from 'vitest'
import { exposedListeners, parseListeners, parseUdpListeners, stackPorts } from './listeners.js'

/** A `/proc/net/tcp` row, with the columns the parser reads. `0A` is LISTEN. */
const row = (index: number, local: string, state = '0A'): string =>
  `  ${index}: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0`

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

const table = (...rows: string[]): string => [HEADER, ...rows, ''].join('\n')

describe('parseUdpListeners', () => {
  // UDP has no LISTEN state: a bound socket reports 07, and that is the one
  // WireGuard's port shows as on a Target with Access enabled.
  it('reads a bound UDP socket, which reports TCP_CLOSE rather than LISTEN', () => {
    expect(parseUdpListeners(table(row(0, '00000000:CA6C', '07')))).toEqual([
      { address: '0.0.0.0', port: 51820, loopback: false },
    ])
  })

  it('ignores a TCP LISTEN row, which cannot appear in a UDP table anyway', () => {
    expect(parseUdpListeners(table(row(0, '00000000:CA6C', '0A')))).toEqual([])
  })
})

describe('parseListeners', () => {
  it('decodes a little-endian IPv4 address and its hex port', () => {
    expect(parseListeners(table(row(0, '0100007F:0BB8')))).toEqual([
      { address: '127.0.0.1', port: 3000, loopback: true },
    ])
  })

  it('reads a wildcard bind as what it is', () => {
    expect(parseListeners(table(row(0, '00000000:2060')))).toEqual([
      { address: '0.0.0.0', port: 8288, loopback: false },
    ])
  })

  it('decodes an IPv6 address a word at a time', () => {
    expect(parseListeners(table(row(0, '00000000000000000000000001000000:0BB8')))).toEqual([
      { address: '::1', port: 3000, loopback: true },
    ])
  })

  it('reads an IPv6 wildcard as reachable', () => {
    expect(parseListeners(table(row(0, '00000000000000000000000000000000:2060')))).toEqual([
      { address: '::', port: 8288, loopback: false },
    ])
  })

  // A dual-stack listener on 127.0.0.1 shows up in tcp6 in this form, and
  // reading it as anything but loopback would fail an install that is correct.
  it('reads a v4-mapped loopback address as loopback', () => {
    expect(parseListeners(table(row(0, '0000000000000000FFFF00000100007F:0BB8')))).toEqual([
      { address: '::ffff:127.0.0.1', port: 3000, loopback: true },
    ])
  })

  it('reads a v4-mapped wildcard as reachable', () => {
    expect(parseListeners(table(row(0, '0000000000000000FFFF000000000000:2060')))[0]).toMatchObject(
      {
        address: '::ffff:0.0.0.0',
        loopback: false,
      },
    )
  })

  it('keeps a routable address readable', () => {
    expect(parseListeners(table(row(0, '0100A8C0:0016')))).toEqual([
      { address: '192.168.0.1', port: 22, loopback: false },
    ])
  })

  it('ignores everything that is not in LISTEN', () => {
    expect(parseListeners(table(row(0, '0100007F:0BB8', '06'), row(1, '0100007F:2060')))).toEqual([
      { address: '127.0.0.1', port: 8288, loopback: true },
    ])
  })

  it('skips the header rather than guessing at it', () => {
    expect(parseListeners(table())).toEqual([])
  })

  it('reads an empty table — a Target with no IPv6 at all', () => {
    expect(parseListeners('')).toEqual([])
  })
})

describe('exposedListeners', () => {
  const ports = stackPorts(3000)

  it('reports a stack port bound off loopback', () => {
    const listeners = parseListeners(table(row(0, '00000000:2060'), row(1, '0100007F:0BB8')))
    expect(exposedListeners(listeners, ports)).toEqual([
      { address: '0.0.0.0', port: 8288, loopback: false },
    ])
  })

  it('passes a stack listening only on loopback', () => {
    const listeners = parseListeners(table(row(0, '0100007F:2060'), row(1, '0100007F:0BB8')))
    expect(exposedListeners(listeners, ports)).toEqual([])
  })

  // A check that failed on sshd is a check the operator learns to ignore.
  it('says nothing about a port the stack does not own', () => {
    expect(exposedListeners(parseListeners(table(row(0, '00000000:0016'))), ports)).toEqual([])
  })

  // Inngest binds these inside its container whatever `--host` says; bridge
  // networking is what keeps them off the Target, so seeing one here means a
  // container ended up on host networking.
  it.each([8289, 50052, 50053])(
    'reports Inngest port %i appearing on the Target at all',
    (port) => {
      const local = `00000000:${port.toString(16).toUpperCase().padStart(4, '0')}`
      expect(exposedListeners(parseListeners(table(row(0, local))), ports)).toHaveLength(1)
    },
  )

  it('watches the Dispatch port the Target actually publishes', () => {
    const listeners = parseListeners(table(row(0, '00000000:0D47')))
    expect(exposedListeners(listeners, stackPorts(3399))).toEqual([
      { address: '0.0.0.0', port: 3399, loopback: false },
    ])
    expect(exposedListeners(listeners, stackPorts(3000))).toEqual([])
  })
})
