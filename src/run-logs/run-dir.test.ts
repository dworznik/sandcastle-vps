import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REDACTED,
  RUN_FILES,
  TAIL_CAP_BYTES,
  locateRun,
  openRunLog,
  redact,
  resolveRunFile,
  runPageUrl,
  validateRunId,
  type RunLog,
} from './run-dir.js'

/** Token-shaped and under 80 characters, so `.gitleaks.toml` stays silent. */
const TOKEN = 'sk-ant-oat01-fixture-token'
const open = (id: string, runId = 'run-1') =>
  openRunLog({ projectPath: project, id, runId, port: 3000, secrets: [TOKEN] })

let workspace: string
let project: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'sandcastle-runs-'))
  project = join(workspace, 'todo')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.sandcastle'), { recursive: true })
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const lines = async (path: string): Promise<Record<string, unknown>[]> =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe('validateRunId', () => {
  it('takes the ids the Orchestrator hands out', () => {
    expect(validateRunId('01K5X3ZQ8N0C1V2B3M4T5E6R7S')).toBe('01K5X3ZQ8N0C1V2B3M4T5E6R7S')
    expect(validateRunId('01K5X3ZQ8N-01K5X3ZR00')).toBe('01K5X3ZQ8N-01K5X3ZR00')
  })

  // The id becomes a path segment on both the writing and the serving side.
  it('refuses anything that is not one plain path segment', () => {
    for (const id of ['', '.', '..', 'a/b', '../x', 'a b', 'x.jsonl', '\u0000', '-x']) {
      expect(() => validateRunId(id)).toThrow(/run id/u)
    }
  })
})

describe('runPageUrl', () => {
  it("is on the Harness's own loopback port, which a tunnel maps unchanged", () => {
    expect(runPageUrl(3000, '01K5X3ZQ8N')).toBe('http://127.0.0.1:3000/runs/01K5X3ZQ8N')
  })
})

describe('openRunLog', () => {
  it('creates the run directory with every file a Run writes, empty', async () => {
    const log = await open('01K5A')
    expect(log.dir).toBe(join(project, '.sandcastle', 'runs', '01K5A'))
    expect(log.url).toBe('http://127.0.0.1:3000/runs/01K5A')
    expect((await readdir(log.dir)).sort()).toEqual([...RUN_FILES].sort())
    for (const file of RUN_FILES) expect((await stat(join(log.dir, file))).size).toBe(0)
    await log.close()
  })

  // A rerun of the same Dispatch from the Orchestrator's dashboard is the one
  // way two Runs share an id; the second gets a directory of its own.
  it('gives a second Run of the same Dispatch its own directory', async () => {
    const first = await open('01K5A')
    await first.close()
    const second = await open('01K5A', 'run-2')
    expect(second.id).toBe('01K5A-run-2')
    expect(second.dir).toBe(join(project, '.sandcastle', 'runs', '01K5A-run-2'))
    expect(second.url).toBe('http://127.0.0.1:3000/runs/01K5A-run-2')
    await second.close()
  })

  it('refuses an id that is not a path segment before touching the disk', async () => {
    await expect(open('../etc')).rejects.toThrow(/run id/u)
  })
})

describe('RunLog', () => {
  let log: RunLog

  beforeEach(async () => {
    log = await open('01K5B')
  })

  afterEach(async () => {
    await log.close()
  })

  it('appends Harness events with a timestamp and source', async () => {
    log.harness('run.started', { project: 'todo' })
    const [event] = await lines(join(log.dir, 'events.jsonl'))
    expect(event).toEqual({
      t: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      project: 'todo',
      source: 'harness',
      type: 'run.started',
    })
  })

  // The verbatim stream beside the reduced events: a reducer is only as good
  // as the raw lines one can check it against.
  it('keeps every raw stream line verbatim and reduces it into events', async () => {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', tools: [] })
    log.stream(init)
    log.stream('not json at all')
    expect(await readFile(join(log.dir, 'stream.jsonl'), 'utf8')).toBe(`${init}\nnot json at all\n`)
    const events = await lines(join(log.dir, 'events.jsonl'))
    expect(events).toEqual([
      expect.objectContaining({ source: 'stream', type: 'session.started', session_id: 's1' }),
    ])
  })

  // The agent can print the Harness's tokens — `env`, `echo $GH_TOKEN` — and
  // the raw stream carries tool output whole. Served to a browser, so no.
  it('scrubs the Harness’s secrets from the raw stream before writing it', async () => {
    log.stream(JSON.stringify({ type: 'user', message: { content: `token=${TOKEN}` } }))
    const raw = await readFile(join(log.dir, 'stream.jsonl'), 'utf8')
    expect(raw).not.toContain(TOKEN)
    expect(raw).toContain(REDACTED)
  })

  it('scrubs the transcript and the subagent transcripts as it copies them', async () => {
    const home = join(workspace, 'home')
    await mkdir(join(home, 'sess-3', 'subagents'), { recursive: true })
    await writeFile(join(home, 'sess-3.jsonl'), `{"out":"${TOKEN}"}\n`)
    await writeFile(join(home, 'sess-3', 'subagents', 'agent-b.jsonl'), `{"out":"${TOKEN}"}\n`)
    await log.captureSession(join(home, 'sess-3.jsonl'))
    expect(await readFile(join(log.dir, 'session', 'sess-3.jsonl'), 'utf8')).toBe(
      `{"out":"${REDACTED}"}\n`,
    )
    expect(await readFile(join(log.dir, 'session', 'subagents', 'agent-b.jsonl'), 'utf8')).toBe(
      `{"out":"${REDACTED}"}\n`,
    )
  })

  // The hooks file is appended to from inside the Sandbox; the log tails it
  // into events.jsonl so one file has the whole picture.
  it('merges hook lines into the events as they are appended', async () => {
    log.watchHooks()
    const hook = { t: '2026-09-24T16:49:22Z', event: 'PreToolUse', tool_name: 'Bash' }
    await appendFile(join(log.dir, 'hooks.jsonl'), `${JSON.stringify(hook)}\n`)
    await log.close()
    const events = await lines(join(log.dir, 'events.jsonl'))
    expect(events).toEqual([{ ...hook, source: 'hook', type: 'hook' }])
  })

  it('reports a hook line it cannot parse rather than dropping it', async () => {
    log.watchHooks()
    await appendFile(join(log.dir, 'hooks.jsonl'), '{broken\n')
    await log.close()
    const events = await lines(join(log.dir, 'events.jsonl'))
    expect(events).toEqual([
      expect.objectContaining({ source: 'hook', type: 'hook.unparsed', line: '{broken' }),
    ])
  })

  // Claude Code's transcript lands under the Harness's own home, which is not
  // a volume; the copy in the run directory is the one that survives.
  it('copies the session transcript and its subagents beside the events', async () => {
    const home = join(workspace, 'home', '.claude', 'projects', '-work-todo')
    await mkdir(join(home, 'sess-1', 'subagents'), { recursive: true })
    await writeFile(join(home, 'sess-1.jsonl'), '{"type":"user"}\n')
    await writeFile(join(home, 'sess-1', 'subagents', 'agent-a1.jsonl'), '{"type":"agent"}\n')

    await log.captureSession(join(home, 'sess-1.jsonl'))

    expect(await readFile(join(log.dir, 'session', 'sess-1.jsonl'), 'utf8')).toBe(
      '{"type":"user"}\n',
    )
    expect(await readdir(join(log.dir, 'session', 'subagents'))).toEqual(['agent-a1.jsonl'])
  })

  it('copies a transcript that has no subagents', async () => {
    const home = join(workspace, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'sess-2.jsonl'), '{}\n')
    await log.captureSession(join(home, 'sess-2.jsonl'))
    expect(await readdir(join(log.dir, 'session'))).toEqual(['sess-2.jsonl'])
  })

  describe('tail', () => {
    it('returns every event when they fit under the cap', async () => {
      log.harness('run.started', {})
      log.harness('run.finished', {})
      expect(await log.tail()).toEqual({
        events: [
          expect.objectContaining({ type: 'run.started' }),
          expect.objectContaining({ type: 'run.finished' }),
        ],
        truncated: false,
      })
    })

    it('keeps the last whole events under the cap, and says it cut', async () => {
      const filler = 'x'.repeat(1000)
      for (let i = 0; i < 40; i += 1) log.harness('big', { i, filler })
      const { events, truncated } = await log.tail()
      expect(truncated).toBe(true)
      expect(events.length).toBeGreaterThan(0)
      expect(events.length).toBeLessThan(40)
      expect(events.at(-1)).toEqual(expect.objectContaining({ i: 39 }))
      expect(JSON.stringify(events).length).toBeLessThanOrEqual(TAIL_CAP_BYTES)
    })
  })
})

describe('locateRun', () => {
  it('finds the run directory under whichever Project holds it', async () => {
    const log = await open('01K5C')
    await log.close()
    expect(await locateRun(workspace, '01K5C')).toBe(log.dir)
  })

  it('answers nothing for an id no Project has', async () => {
    expect(await locateRun(workspace, '01K5D')).toBeUndefined()
  })

  it('refuses an id that is not a path segment', async () => {
    await expect(locateRun(workspace, '../x')).rejects.toThrow(/run id/u)
  })
})

describe('resolveRunFile', () => {
  const dir = '/work/todo/.sandcastle/runs/01K5E'

  it('names each of the files a Run writes, with its content type', () => {
    expect(resolveRunFile(dir, 'events.jsonl')).toEqual({
      path: join(dir, 'events.jsonl'),
      contentType: 'application/x-ndjson',
    })
    expect(resolveRunFile(dir, 'sandcastle.log')).toEqual({
      path: join(dir, 'sandcastle.log'),
      contentType: 'text/plain; charset=utf-8',
    })
  })

  it('reaches the transcript and its subagents under session/', () => {
    expect(resolveRunFile(dir, 'session/sess-1.jsonl')?.path).toBe(
      join(dir, 'session', 'sess-1.jsonl'),
    )
    expect(resolveRunFile(dir, 'session/subagents/agent-a1.jsonl')?.path).toBe(
      join(dir, 'session', 'subagents', 'agent-a1.jsonl'),
    )
  })

  it('serves nothing else', () => {
    for (const file of [
      '',
      'index.html',
      '../events.jsonl',
      'session/../../.env',
      'session/.hidden.jsonl',
      'session/notes.txt',
      'session/subagents/x/y.jsonl',
      'events.jsonl/',
    ]) {
      expect(resolveRunFile(dir, file)).toBeUndefined()
    }
  })
})

describe('redact', () => {
  it('replaces every occurrence of each secret, and nothing else', () => {
    expect(redact(`a ${TOKEN} b ${TOKEN} c ghp_x`, [TOKEN, 'ghp_x'])).toBe(
      `a ${REDACTED} b ${REDACTED} c ${REDACTED}`,
    )
  })

  it('leaves text alone when there is nothing to scrub', () => {
    expect(redact('plain', [])).toBe('plain')
    expect(redact('plain', [''])).toBe('plain')
  })
})
