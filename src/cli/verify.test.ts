import { describe, expect, it } from 'vitest'
import type { Connector, ExecResult } from './connectors/types.js'
import { parseListeners } from './listeners.js'
import {
  LISTENERS_SCRIPT,
  appsQueryScript,
  dispatchCheck,
  dispatchProbeScript,
  exposureCheck,
  parseBothTables,
  formatChecks,
  syncCheck,
  verifyInstall,
} from './verify.js'

const apps = (...entries: unknown[]): string => JSON.stringify({ data: { apps: entries } })

const synced = { name: 'sandcastle-vps', connected: true, functionCount: 1, error: null }

describe('syncCheck', () => {
  it('passes when the Orchestrator has the Harness and its function', () => {
    expect(syncCheck(apps(synced))).toMatchObject({ ok: true })
  })

  // The window between the Harness listening and the Orchestrator syncing it
  // is real, so this is the routine first answer rather than a failure mode.
  it('fails while the Orchestrator has synced nothing', () => {
    expect(syncCheck(apps())).toMatchObject({ ok: false, detail: /synced no app/ })
  })

  it('fails when the only synced app is somebody else', () => {
    expect(syncCheck(apps({ ...synced, name: 'something-else' }))).toMatchObject({ ok: false })
  })

  // A synced app with an error is how the Orchestrator reports that it reached
  // the URL and did not like what it found, which reads as success otherwise.
  it('reports the error the Orchestrator recorded against the app', () => {
    expect(syncCheck(apps({ ...synced, error: 'error validating signing key' }))).toMatchObject({
      ok: false,
      detail: expect.stringContaining('error validating signing key'),
    })
  })

  it('fails on an app that synced with no functions', () => {
    expect(syncCheck(apps({ ...synced, functionCount: 0 }))).toMatchObject({ ok: false })
  })

  // What docker says when the container is not up yet. It is not JSON, and
  // reporting "invalid JSON" would hide the sentence that explains it.
  it('reports a non-JSON answer as what it is', () => {
    expect(syncCheck('service "harness" is not running\nmore noise')).toEqual({
      ok: false,
      label: 'Harness synced',
      detail: 'service "harness" is not running',
    })
  })
})

describe('exposureCheck', () => {
  const table = (...locals: string[]): string =>
    [
      '  sl  local_address rem_address   st',
      ...locals.map(
        (local, index) =>
          `  ${index}: ${local} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 1 1`,
      ),
      '',
    ].join('\n')

  const listeners = (...locals: string[]) => parseListeners(table(...locals))

  it('passes a stack listening only on loopback', () => {
    // 3000 and 8288, both on 127.0.0.1.
    expect(exposureCheck(listeners('0100007F:0BB8', '0100007F:2060'), 3000)).toMatchObject({
      ok: true,
    })
  })

  it('refuses a Dispatch surface bound off loopback', () => {
    expect(exposureCheck(listeners('00000000:0BB8'), 3000)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('0.0.0.0:3000'),
    })
  })

  // The stack not being up is not the same as the stack being safe, and a
  // check that cannot tell them apart passes on a Target with nothing on it.
  it('does not pass a Target where nothing is listening at all', () => {
    expect(exposureCheck(listeners(), 3000)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('nothing is listening on 3000'),
    })
  })
})

describe('parseBothTables', () => {
  it('reads the IPv4 and IPv6 tables the probe concatenates', () => {
    const stdout = [
      '  sl  local_address rem_address   st',
      '   0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
      '=====',
      '  sl  local_address                         remote_address                        st',
      '   0: 00000000000000000000000001000000:2060 00000000000000000000000000000000:0000 0A 0 0 0 0 0 1000 0 1 1',
      '',
    ].join('\n')
    expect(parseBothTables(stdout)).toEqual([
      { address: '127.0.0.1', port: 3000, loopback: true },
      { address: '::1', port: 8288, loopback: true },
    ])
  })

  it('survives a Target with no IPv6 table to read', () => {
    expect(parseBothTables('=====\n')).toEqual([])
  })
})

describe('dispatchCheck', () => {
  it('passes on the 400 a Project that does not exist earns', () => {
    expect(dispatchCheck('{"error":"Project \\"x\\" is not a git checkout"}\n400')).toMatchObject({
      ok: true,
    })
  })

  // 202 here would mean the Harness queued a Run against a Project it never
  // resolved, which is a bug this check exists to catch.
  it('refuses a 202 for a Project that does not exist', () => {
    expect(dispatchCheck('{"ids":["01"]}\n202')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('202'),
    })
  })

  it('reports a Harness that answered nothing', () => {
    expect(dispatchCheck('')).toMatchObject({ ok: false })
  })
})

describe('the probe scripts', () => {
  // Inside the Harness container, `127.0.0.1` is that container's loopback,
  // not the Target's — so a `ports:` mapping that never took effect would
  // still pass. `--network host` is what makes these outside checks.
  it("probes the Target's own loopback, not a container's", () => {
    const script = appsQueryScript('/home/op/.sandcastle-vps')
    expect(script).toContain('docker run --rm --network host')
    expect(script).toContain('http://127.0.0.1:8288/v0/gql')
  })

  it('borrows the image the install just built, rather than pulling one', () => {
    expect(appsQueryScript('/opt/x')).toContain('docker compose images -q harness')
  })

  // The Target is not required to have curl — preflight asks for Docker and
  // nothing else — so every HTTP probe has to run in a container we ship.
  it('never asks the Target itself for an HTTP client', () => {
    const script = dispatchProbeScript('/opt/x', 3000, 'nope')
    expect(script).toContain('docker run --rm --network host')
    expect(script).toContain('curl')
  })

  // The published Dispatch port is the surface being checked; hitting any
  // other one would be checking something an operator never uses.
  it('sends the Dispatch to the port the Target publishes', () => {
    expect(dispatchProbeScript('/opt/x', 3399, 'nope')).toContain('http://127.0.0.1:3399/dispatch')
  })

  it('quotes the install directory, which the operator chose', () => {
    expect(appsQueryScript("/home/o'brien/stack")).toContain("cd '/home/o'\\''brien/stack'")
  })

  it('reads the listener tables without needing iproute2', () => {
    expect(LISTENERS_SCRIPT).toContain('/proc/net/tcp')
    expect(LISTENERS_SCRIPT).not.toContain('ss ')
  })
})

describe('verifyInstall', () => {
  const ok: ExecResult = { code: 0, stdout: '', stderr: '' }

  /** Answers keyed by a fragment of the script, so a test says what it is
   *  simulating rather than counting calls. */
  const connectorAnswering = (
    answers: readonly (readonly [string, string | (() => string)])[],
  ): Connector & { readonly calls: string[] } => {
    const calls: string[] = []
    return {
      kind: 'ssh',
      calls,
      exec: async (script) => {
        calls.push(script)
        const match = answers.find(([fragment]) => script.includes(fragment))
        const answer = match?.[1]
        return { ...ok, stdout: typeof answer === 'function' ? answer() : (answer ?? '') }
      },
      putTar: async () => {},
      preflight: async () => ({ ok: true, checks: [], canElevate: false, user: 'op' }),
    }
  }

  const loopbackOnly = [
    '  sl  local_address rem_address   st',
    '   0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
    '   1: 0100007F:2060 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
    '',
  ].join('\n')

  const options = {
    installDir: '/home/op/.sandcastle-vps',
    harnessPort: 3000,
    sleep: async () => {},
    absentProject: 'no-such-project',
  }

  it('reports all three checks', async () => {
    const connector = connectorAnswering([
      ['/v0/gql', apps(synced)],
      ['/proc/net/tcp', loopbackOnly],
      ['/dispatch', 'body\n400'],
    ])
    expect(await verifyInstall(connector, options)).toEqual([
      expect.objectContaining({ label: 'Harness synced', ok: true }),
      expect.objectContaining({ label: 'loopback only', ok: true }),
      expect.objectContaining({ label: 'Dispatch refuses', ok: true }),
    ])
  })

  // The Orchestrator syncs on its own schedule, so an install that asked once
  // would fail on a Target that was about to be fine.
  it('waits for the Orchestrator to sync rather than asking once', async () => {
    let asked = 0
    const connector = connectorAnswering([
      ['/v0/gql', () => (++asked < 3 ? apps() : apps(synced))],
      ['/proc/net/tcp', loopbackOnly],
      ['/dispatch', 'body\n400'],
    ])
    const [sync] = await verifyInstall(connector, options)
    expect(sync).toMatchObject({ ok: true })
    expect(asked).toBe(3)
  })

  it('gives up after the attempts it was given, and says what it last saw', async () => {
    const connector = connectorAnswering([
      ['/v0/gql', apps()],
      ['/proc/net/tcp', loopbackOnly],
      ['/dispatch', 'body\n400'],
    ])
    const [sync] = await verifyInstall(connector, { ...options, attempts: 2 })
    expect(sync).toMatchObject({ ok: false, detail: expect.stringContaining('synced no app') })
  })

  // Checking a keyless surface should not be able to start work on it.
  it('dispatches only to the Project name it was told cannot exist', async () => {
    const connector = connectorAnswering([
      ['/v0/gql', apps(synced)],
      ['/proc/net/tcp', loopbackOnly],
      ['/dispatch', 'body\n400'],
    ])
    await verifyInstall(connector, options)
    const dispatch = connector.calls.find((call) => call.includes('/dispatch'))
    expect(dispatch).toContain('no-such-project')
  })

  it('still reports the other two when the Harness never syncs', async () => {
    const connector = connectorAnswering([
      ['/v0/gql', 'service "harness" is not running'],
      ['/proc/net/tcp', loopbackOnly],
      ['/dispatch', 'body\n400'],
    ])
    const checks = await verifyInstall(connector, { ...options, attempts: 1 })
    expect(checks.map((check) => check.ok)).toEqual([false, true, true])
  })
})

describe('formatChecks', () => {
  // Caught on a real Target: `dispatch refuses` is 16 characters, and a column
  // exactly that wide printed "dispatch refuses400 for a Project…".
  it('leaves a gap after the longest label', () => {
    const line = formatChecks([
      { ok: true, label: 'Dispatch refuses', detail: '400 for a Project that does not exist' },
    ])
    expect(line).toContain('Dispatch refuses  400')
  })

  it('marks a failing check so it can be found in a scroll-back', () => {
    expect(formatChecks([{ ok: false, label: 'loopback only', detail: 'x' }])).toContain('FAIL')
  })
})
