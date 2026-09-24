import { appendFileSync } from 'node:fs'
import { cp, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { listProjects } from '../projects.js'
import { StreamReducer, type StreamEvent } from './reducer.js'

/**
 * A Run's directory: everything observed about one Run, kept by the Harness
 * under the Project and served back by id.
 *
 * `<project>/.sandcastle/runs/<id>/`, created as soon as the Project is
 * resolved and before anything that can fail, so a Run that dies early still
 * has a place that says so. The id is the one the Dispatch answered with —
 * the Orchestrator's event id — so the operator has the link before the Run
 * starts; the function's own run id is recorded inside. One Dispatch is one
 * Run while retries stay at zero (ADR 0002), and a rerun of the same event
 * from the dashboard gets a directory of its own.
 */

/** The files a Run writes. `session/` is added when the transcript is copied. */
export const RUN_FILES = ['events.jsonl', 'stream.jsonl', 'hooks.jsonl', 'sandcastle.log'] as const

export type RunFile = (typeof RUN_FILES)[number]

const RUNS_DIR = join('.sandcastle', 'runs')

/**
 * The size of the tail a Run's result carries. The result is stored by the
 * Orchestrator and shown on its run page, so it stays small; the whole file
 * is one click away behind the URL beside it.
 */
export const TAIL_CAP_BYTES = 16 * 1024

/** How often the hooks file is checked for new lines. Polling rather than
 *  `fs.watch`: the writer is a container on a bind mount, and inotify across
 *  that boundary is not something to rely on. */
const HOOK_POLL_MS = 250

/** ULIDs, and a ULID with a run id appended. Nothing with a dot, so no
 *  `..` and no file extension; nothing with a slash, so one path segment. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u

/** The id becomes a path segment on both the writing and the serving side. */
export const validateRunId = (id: string): string => {
  if (!RUN_ID.test(id)) throw new Error(`Invalid run id: ${JSON.stringify(id)}`)
  return id
}

/** Through a tunnel that maps the same local port, this works unchanged. */
export const runPageUrl = (port: number, id: string): string =>
  `http://127.0.0.1:${port}/runs/${id}`

export type EventSource = 'harness' | 'stream' | 'hook'

/** One line of `events.jsonl`. */
export interface RunEvent extends StreamEvent {
  readonly t: string
  readonly source: EventSource
}

export interface Tail {
  readonly events: RunEvent[]
  /** Whether older events were cut to fit `TAIL_CAP_BYTES`. */
  readonly truncated: boolean
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Tail a file that another process appends whole lines to. The writer is the
 * Sandbox, through a bind mount of the file.
 */
class HookTail {
  private offset = 0
  private partial = ''
  private busy = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly path: string,
    private readonly onLine: (line: string) => void,
    /** A read that failed. The next poll tries again from the same offset. */
    private readonly onError: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.busy) return
      this.busy = true
      void this.drain()
        .catch((error: unknown) => {
          this.onError(error)
        })
        .finally(() => {
          this.busy = false
        })
    }, HOOK_POLL_MS)
  }

  /** Stops polling and reads whatever arrived since the last poll. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.drain()
  }

  private async drain(): Promise<void> {
    let handle
    try {
      handle = await open(this.path, 'r')
    } catch {
      return
    }
    try {
      const { size } = await handle.stat()
      if (size <= this.offset) return
      const buffer = Buffer.alloc(size - this.offset)
      await handle.read(buffer, 0, buffer.length, this.offset)
      this.offset = size
      const chunks = (this.partial + buffer.toString('utf8')).split('\n')
      this.partial = chunks.pop() ?? ''
      for (const line of chunks) if (line.trim()) this.onLine(line)
    } finally {
      await handle.close()
    }
  }
}

/**
 * A Run's log, open for the life of the Run. Every observation goes through
 * here, so `events.jsonl` has one envelope and one writer.
 */
export class RunLog {
  private readonly events: string
  private readonly reducer: StreamReducer
  private readonly hooks: HookTail

  constructor(
    /** The id the directory is named by — the Dispatch's, or the Dispatch's
     *  with the run id appended when that directory was already taken. */
    readonly id: string,
    readonly dir: string,
  ) {
    this.events = join(dir, 'events.jsonl')
    this.reducer = new StreamReducer((event) => this.append('stream', event))
    this.hooks = new HookTail(
      join(dir, 'hooks.jsonl'),
      (line) => {
        try {
          this.append('hook', { type: 'hook', ...(JSON.parse(line) as Record<string, unknown>) })
        } catch {
          this.append('hook', { type: 'hook.unparsed', line })
        }
      },
      (error) => {
        this.append('hook', { type: 'hook.tail_failed', error: String(error) })
      },
    )
  }

  /** The host path of the hooks file, for the Sandbox's bind mount. */
  get hooksFile(): string {
    return join(this.dir, 'hooks.jsonl')
  }

  /** A phase of the Run itself: started, image ready, finished, failed. */
  harness(type: string, data: Record<string, unknown>): void {
    this.append('harness', { type, ...data })
  }

  /** One raw line of the agent's `stream-json` output: kept verbatim, and
   *  reduced into events. */
  stream(line: string): void {
    appendFileSync(join(this.dir, 'stream.jsonl'), `${line}\n`)
    this.reducer.push(line)
  }

  /** Start merging the Sandbox's hook lines into the events. */
  watchHooks(): void {
    this.hooks.start()
  }

  /**
   * Copy the captured Claude Code transcript, and the subagent transcripts
   * beside it, into `session/`. sandcastle lands them under this process's
   * home, which in the Harness container is not a volume.
   */
  async captureSession(sessionFilePath: string): Promise<void> {
    const session = join(this.dir, 'session')
    await mkdir(session, { recursive: true })
    await cp(sessionFilePath, join(session, basename(sessionFilePath)))
    const id = basename(sessionFilePath, '.jsonl')
    const subagents = join(dirname(sessionFilePath), id, 'subagents')
    if (await exists(subagents)) {
      await cp(subagents, join(session, 'subagents'), { recursive: true })
    }
  }

  /** The last events, capped by size, for the Run's result. */
  async tail(): Promise<Tail> {
    const handle = await open(this.events, 'r')
    try {
      const { size } = await handle.stat()
      const truncated = size > TAIL_CAP_BYTES
      const length = Math.min(size, TAIL_CAP_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n')
      // A cut lands mid-line; the first fragment is not an event.
      if (truncated) lines.shift()
      const events: RunEvent[] = []
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line) as RunEvent)
        } catch {
          // A line still being written. The next tail has it whole.
        }
      }
      return { events, truncated }
    } finally {
      await handle.close()
    }
  }

  /** Stop watching the hooks file, draining what arrived last. Idempotent. */
  async close(): Promise<void> {
    this.reducer.end()
    await this.hooks.stop()
  }

  private append(source: EventSource, event: StreamEvent): void {
    const { type, ...data } = event
    const line: RunEvent = { t: new Date().toISOString(), ...data, source, type }
    appendFileSync(this.events, `${JSON.stringify(line)}\n`)
  }
}

/**
 * Create the run directory and open its log. Every file is created empty
 * now, so the Sandbox can bind-mount the hooks file — Docker creates a
 * *directory* for a bind source that does not exist — and so the run page
 * finds an `events.jsonl` to tail from the first second.
 */
export const openRunLog = async (input: {
  readonly projectPath: string
  /** The id the Dispatch answered with. */
  readonly id: string
  /** The Orchestrator's id for this invocation of the function. */
  readonly runId: string
}): Promise<RunLog> => {
  const dispatched = validateRunId(input.id)
  const runs = join(input.projectPath, RUNS_DIR)
  let id = dispatched
  if (await exists(join(runs, id))) {
    id = validateRunId(`${dispatched}-${input.runId}`)
  }
  const dir = join(runs, id)
  await mkdir(dir, { recursive: true })
  await Promise.all(RUN_FILES.map((file) => writeFile(join(dir, file), '', { flag: 'a' })))
  return new RunLog(id, dir)
}

/**
 * The run directory for an id, under whichever Project holds it. A scan
 * rather than an index: there is no index to keep consistent, and the scale
 * is tens of Projects.
 */
export const locateRun = async (workspaceRoot: string, id: string): Promise<string | undefined> => {
  const wanted = validateRunId(id)
  for (const project of await listProjects(workspaceRoot)) {
    const dir = join(project.path, RUNS_DIR, wanted)
    if (await exists(dir)) return dir
  }
  return undefined
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.jsonl': 'application/x-ndjson',
  '.log': 'text/plain; charset=utf-8',
}

/** A transcript file name: `<uuid>.jsonl` or `agent-<id>.jsonl`. Nothing
 *  hidden, nothing with a slash, and only the one extension. */
const TRANSCRIPT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u

/**
 * Which file under a run directory a request may read, and as what. One of
 * the files a Run writes, or a transcript under `session/`; anything else is
 * nothing, which the route answers as 404.
 */
export const resolveRunFile = (
  dir: string,
  file: string,
): { readonly path: string; readonly contentType: string } | undefined => {
  const segments = file.split('/')
  let relative: string[] | undefined
  if (segments.length === 1 && (RUN_FILES as readonly string[]).includes(segments[0] ?? '')) {
    relative = segments
  } else if (segments.length === 2 && segments[0] === 'session') {
    relative = segments
  } else if (segments.length === 3 && segments[0] === 'session' && segments[1] === 'subagents') {
    relative = segments
  }
  if (!relative) return undefined
  const name = relative.at(-1) ?? ''
  if (relative.length > 1 && !TRANSCRIPT.test(name)) return undefined
  const extension = name.slice(name.lastIndexOf('.'))
  const contentType = CONTENT_TYPES[extension]
  if (!contentType) return undefined
  return { path: join(dir, ...relative), contentType }
}
