import { describe, expect, it } from 'vitest'
import type { Connector, ExecResult } from './connectors/types.js'
import {
  FACTS_SCRIPT,
  desiredEnv,
  divergences,
  harnessPort,
  nextSteps,
  parseFacts,
  provision,
  secretsDir,
  writeEnvScript,
  type TargetFacts,
} from './install.js'
import type { TargetProfile } from './profiles.js'
import { readEnv, upsertAllEnv } from './target-env.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const facts: TargetFacts = {
  operatorUid: '1000',
  operatorGid: '1000',
  dockerGid: '988',
  inngestEventKey: 'a'.repeat(64),
  inngestSigningKey: 'b'.repeat(64),
}

/** What the probe script prints, in the shape `parseFacts` reads. */
const probeOutput = (overrides: Record<string, string> = {}): string =>
  Object.entries({
    uid: '1000',
    gid: '1000',
    'docker-gid': '988',
    'event-key': 'a'.repeat(64),
    'signing-key': 'b'.repeat(64),
    ...overrides,
  })
    .map(([key, value]) => `${key}\t${value}`)
    .join('\n')

describe('parseFacts', () => {
  it('reads what the Target reported about itself', () => {
    expect(parseFacts(`${probeOutput()}\n`)).toEqual(facts)
  })

  // Guessing 1000:1000 is how worktrees end up owned by the wrong account on a
  // Target whose operator is not the first user created on it.
  it('refuses to guess when the Target answered nothing', () => {
    expect(() => parseFacts('')).toThrow(/uid, gid/)
  })

  it('names the docker group as the thing that is missing, not a uid', () => {
    expect(() => parseFacts(probeOutput({ 'docker-gid': '' }))).toThrow(/docker` group/)
  })

  it('generates the Inngest keys on the Target, not here', () => {
    expect(FACTS_SCRIPT).toContain('/dev/urandom')
    expect(FACTS_SCRIPT).toContain('openssl rand -hex 32')
  })
})

describe('desiredEnv', () => {
  it('writes the workspace root and the secrets directory the stack mounts', () => {
    expect(desiredEnv(profile, facts)).toMatchObject({
      WORKSPACE_ROOT: '/home/op/work',
      SECRETS_DIR: '/home/op/.sandcastle-vps/secrets',
    })
  })

  it('carries the ids the Target reported, rather than this machine', () => {
    expect(desiredEnv(profile, facts)).toMatchObject({
      OPERATOR_UID: '1000',
      OPERATOR_GID: '1000',
      DOCKER_GID: '988',
    })
  })

  // An install runs before the wizard has captured anything and again after.
  // Writing empty placeholders for the credentials would, on the second run,
  // be seeding — which keeps them — but the intent has to be visible here:
  // this function never mentions a credential at all.
  it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'AGENT_GIT_NAME', 'AGENT_GIT_EMAIL'])(
    'does not write %s, which is for the wizard to capture',
    (key) => {
      expect(Object.keys(desiredEnv(profile, facts))).not.toContain(key)
    },
  )
})

describe('a re-run against an installed Target', () => {
  const first = upsertAllEnv('', desiredEnv(profile, facts), 'seed')

  it('changes nothing when nothing about the Target changed', () => {
    expect(upsertAllEnv(first, desiredEnv(profile, facts), 'seed')).toBe(first)
  })

  // The Inngest keys are freshly generated on every run and thrown away on
  // every run but the first. Rotating them would log the Orchestrator out of
  // itself, and the Runs in flight with it.
  it('keeps the Inngest keys the Target already generated', () => {
    const second = upsertAllEnv(
      first,
      desiredEnv(profile, { ...facts, inngestEventKey: 'c'.repeat(64) }),
      'seed',
    )
    expect(readEnv(second, 'INNGEST_EVENT_KEY')).toBe('a'.repeat(64))
  })

  it('keeps a credential the wizard captured in between', () => {
    const captured = upsertAllEnv(first, { GH_TOKEN: 'github_pat_captured' }, 'rotate')
    const second = upsertAllEnv(captured, desiredEnv(profile, facts), 'seed')
    expect(readEnv(second, 'GH_TOKEN')).toBe('github_pat_captured')
  })

  it('keeps a value the operator edited by hand', () => {
    const edited = upsertAllEnv(first, { WORKSPACE_ROOT: '/srv/projects' }, 'rotate')
    expect(
      readEnv(upsertAllEnv(edited, desiredEnv(profile, facts), 'seed'), 'WORKSPACE_ROOT'),
    ).toBe('/srv/projects')
  })
})

describe('divergences', () => {
  // Keeping a stale workspace root silently is how a Run ends up looking for
  // Projects in a directory the operator stopped using.
  it('reports a setting the Target keeps that this install would have written differently', () => {
    const existing = 'WORKSPACE_ROOT=/srv/projects\n'
    expect(divergences(existing, desiredEnv(profile, facts))).toEqual([
      { key: 'WORKSPACE_ROOT', kept: '/srv/projects', offered: '/home/op/work' },
    ])
  })

  it('says nothing about a fresh Target', () => {
    expect(divergences('', desiredEnv(profile, facts))).toEqual([])
  })

  it('says nothing about a Target that agrees', () => {
    const existing = upsertAllEnv('', desiredEnv(profile, facts), 'seed')
    expect(divergences(existing, desiredEnv(profile, facts))).toEqual([])
  })

  // Reporting that a freshly generated key differs from the stored one is
  // reporting that random numbers are random.
  it('says nothing about the Inngest keys, which differ every run by design', () => {
    const existing = upsertAllEnv('', desiredEnv(profile, facts), 'seed')
    const later = desiredEnv(profile, { ...facts, inngestEventKey: 'c'.repeat(64) })
    expect(divergences(existing, later)).toEqual([])
  })
})

describe('harnessPort', () => {
  it('takes the port the operator pinned', () => {
    expect(harnessPort('PORT=3399\n')).toBe(3399)
  })

  it("falls back to compose's own default", () => {
    expect(harnessPort('')).toBe(3000)
    expect(harnessPort('#PORT=3399\n')).toBe(3000)
    expect(harnessPort('PORT=\n')).toBe(3000)
  })

  // A checked port that is not the published one is a check of nothing.
  it.each(['0', 'abc', '70000'])('ignores PORT=%o rather than checking it', (port) => {
    expect(harnessPort(`PORT=${port}\n`)).toBe(3000)
  })
})

describe('writeEnvScript', () => {
  it('leaves the file readable only by the operator', () => {
    expect(writeEnvScript('/opt/x')).toContain('chmod 600')
    expect(writeEnvScript('/opt/x')).toContain('umask 077')
  })

  // The content is the agent's credentials on every run after the first, and a
  // script is an argument list other processes on the Target can read.
  it('never puts the content in the script', () => {
    expect(writeEnvScript('/opt/x')).toContain('cat > "$tmp"')
  })

  // A failed write must not be able to leave half a file where the
  // credentials were.
  it('moves the finished file into place rather than writing over the old one', () => {
    expect(writeEnvScript('/opt/x')).toMatch(/mv "\$tmp" '\/opt\/x'\/\.env/)
  })

  it('creates the secrets directory the compose mount needs', () => {
    expect(writeEnvScript('/opt/x')).toContain(`mkdir -p '${secretsDir('/opt/x')}'`)
    expect(writeEnvScript('/opt/x')).toContain('chmod 700')
  })

  it('quotes the install directory, which the operator chose', () => {
    expect(writeEnvScript("/home/o'brien/x")).toContain("'/home/o'\\''brien/x'")
  })
})

describe('nextSteps', () => {
  const passed = [{ ok: true, label: 'harness synced', detail: '' }]

  it('sends the operator to credential capture, because no Run works without it', () => {
    expect(nextSteps(profile, 3000, passed)).toContain('credentials')
  })

  it('names the port the Target actually publishes', () => {
    expect(nextSteps(profile, 3399, passed)).toContain('127.0.0.1:3399')
  })

  // Nothing behind the Dispatch surface authenticates, so a failed exposure
  // check is not a footnote.
  it('warns rather than congratulating when a check did not pass', () => {
    const checks = [{ ok: false, label: 'loopback only', detail: '0.0.0.0:3000' }]
    expect(nextSteps(profile, 3000, checks)).toContain('did not pass')
    expect(nextSteps(profile, 3000, checks)).toContain('logs --tail 40 harness')
  })
})

describe('provision', () => {
  const ok: ExecResult = { code: 0, stdout: '', stderr: '' }

  const loopbackOnly = [
    '  sl  local_address rem_address   st',
    '   0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
    '   1: 0100007F:2060 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
    '',
  ].join('\n')

  const synced = JSON.stringify({
    data: { apps: [{ name: 'sandcastle-vps', connected: true, functionCount: 1, error: null }] },
  })

  interface Call {
    readonly script: string
    readonly stdin?: string
  }

  /** A Target that answers the way a healthy one does, remembering what it was
   *  asked. `installed` is the environment file it already has. */
  const fakeTarget = (installed = '', overrides: Partial<Record<string, ExecResult>> = {}) => {
    const calls: Call[] = []
    const answer = (script: string): ExecResult => {
      for (const [fragment, result] of Object.entries(overrides)) {
        if (result && script.includes(fragment)) return result
      }
      if (script.includes("printf 'uid")) return { ...ok, stdout: `${probeOutput()}\n` }
      // Before the `cat` below: reading the listener tables is also a `cat`.
      if (script.includes('/proc/net/tcp')) return { ...ok, stdout: loopbackOnly }
      if (script.startsWith('cat ')) return { ...ok, stdout: installed }
      if (script.includes('/v0/gql')) return { ...ok, stdout: synced }
      if (script.includes('/dispatch')) return { ...ok, stdout: 'body\n400' }
      if (script.includes('compose ps')) return { ...ok, stdout: 'NAME  STATUS\nharness  Up' }
      return ok
    }
    const connector: Connector = {
      kind: 'ssh',
      exec: async (script, opts) => {
        calls.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : undefined })
        return answer(script)
      },
      putTar: async () => {},
      preflight: async () => ({ ok: true, checks: [], canElevate: false, user: 'op' }),
    }
    return { connector, calls }
  }

  const silent = () => {}
  const quick = { sleep: async () => {}, attempts: 1, absentProject: 'no-such-project' }

  /** What the install sent to be written as the Target's environment file. */
  const written = (calls: readonly Call[]): string =>
    calls.find((call) => call.stdin !== undefined)?.stdin ?? ''

  it('writes the environment the Target needs and starts the stack', async () => {
    const { connector, calls } = fakeTarget()
    const checks = await provision({ profile, connector }, silent, quick)

    expect(readEnv(written(calls), 'WORKSPACE_ROOT')).toBe('/home/op/work')
    expect(readEnv(written(calls), 'DOCKER_GID')).toBe('988')
    expect(readEnv(written(calls), 'SECRETS_DIR')).toBe('/home/op/.sandcastle-vps/secrets')
    expect(calls.map((call) => call.script)).toContainEqual(
      expect.stringContaining('docker compose up -d --build --remove-orphans'),
    )
    expect(checks.every((check) => check.ok)).toBe(true)
  })

  // The Harness image is built from the delivered package, so an upgrade that
  // did not rebuild would start the old code from the new files.
  it('rebuilds the Harness image, so a newer package takes effect', async () => {
    const { connector, calls } = fakeTarget()
    await provision({ profile, connector }, silent, quick)
    const up = calls.find((call) => call.script.includes('compose up'))
    expect(up?.script).toContain('--build')
  })

  it('is idempotent: a re-run writes back what the Target already had', async () => {
    const first = fakeTarget()
    await provision({ profile, connector: first.connector }, silent, quick)
    const installed = written(first.calls)

    const second = fakeTarget(installed)
    await provision({ profile, connector: second.connector }, silent, quick)
    expect(written(second.calls)).toBe(installed)
  })

  it('leaves a credential captured since the last install alone', async () => {
    const installed = upsertAllEnv(
      upsertAllEnv('', desiredEnv(profile, facts), 'seed'),
      { GH_TOKEN: 'github_pat_captured' },
      'rotate',
    )
    const { connector, calls } = fakeTarget(installed)
    await provision({ profile, connector }, silent, quick)
    expect(readEnv(written(calls), 'GH_TOKEN')).toBe('github_pat_captured')
  })

  it('reports a divergence it decided not to apply', async () => {
    const lines: string[] = []
    const { connector } = fakeTarget('WORKSPACE_ROOT=/srv/projects\n')
    await provision({ profile, connector }, (line) => lines.push(line), quick)
    expect(lines.join('\n')).toContain('keeping WORKSPACE_ROOT=/srv/projects')
  })

  it('stops rather than starting a stack it could not configure', async () => {
    const { connector } = fakeTarget('', {
      'mkdir -p': { code: 1, stdout: '', stderr: 'Read-only file system' },
    })
    await expect(provision({ profile, connector }, silent, quick)).rejects.toThrow(
      /Read-only file system/,
    )
  })

  it('stops rather than checking a stack that would not start', async () => {
    const { connector } = fakeTarget('', {
      'compose up': { code: 1, stdout: '', stderr: 'failed to solve: no space left on device' },
    })
    await expect(provision({ profile, connector }, silent, quick)).rejects.toThrow(/no space left/)
  })

  // The verification is the reason this is not just `docker compose up`.
  it('reports a stack that came up reachable off loopback rather than passing it', async () => {
    const exposed = [
      '  sl  local_address rem_address   st',
      '   0: 00000000:0BB8 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
      '',
    ].join('\n')
    const { connector } = fakeTarget('', { '/proc/net/tcp': { ...ok, stdout: exposed } })
    const checks = await provision({ profile, connector }, silent, quick)
    expect(checks.find((check) => check.label === 'loopback only')).toMatchObject({ ok: false })
  })

  // PORT is the Target's to pin, and checking 3000 on a Target publishing 3399
  // is checking nothing.
  it('checks the Dispatch port the Target actually publishes', async () => {
    const { connector, calls } = fakeTarget('PORT=3399\n')
    await provision({ profile, connector }, silent, quick)
    expect(calls.map((call) => call.script)).toContainEqual(
      expect.stringContaining('http://127.0.0.1:3399/dispatch'),
    )
  })
})
