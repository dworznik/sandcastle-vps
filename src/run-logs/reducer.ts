/**
 * Folds Claude Code's `stream-json` output into one event per thing worth
 * looking at on a run page: a model call with the tool calls it issued, a
 * subagent's lifecycle, a session start or resume, an invocation's result,
 * and the subscription's rate-limit windows.
 *
 * Pure: lines in, events out through a sink. Nothing here knows about files,
 * clocks or the Harness — the run log adds the envelope (timestamp, source)
 * and the tests replay a captured stream through it.
 *
 * The stream carries one `assistant` line per content block, all sharing the
 * message id of the call that produced them, then `user` lines with the tool
 * results. A call is complete only when the next call on the same thread
 * starts, a `result` line arrives, or — for a subagent's last call — its task
 * notification does, because its results trail it. That is when the event is
 * emitted.
 *
 * Threads: a subagent's lines carry `parent_tool_use_id`, the Agent call that
 * spawned it, and interleave with the parent's. Subagents run in the
 * background, so the parent keeps issuing calls while the child works, and
 * the child's blocks for one message can arrive seconds apart with parent
 * messages in between. Open calls are therefore kept per message and closed
 * per thread, never on a global "last message" rule — the first version of
 * this did that and split one subagent call in two.
 *
 * Invocations: a session whose subagent finishes after the parent stopped is
 * woken up again with a task notification. Each wake-up is a fresh
 * `system/init` line and, at the very end, its own `result` line. The session
 * id stays the same, and the `result` lines all arrive together after the
 * last `init` — so results are numbered on their own counter.
 */

export interface ToolUse {
  readonly id: string
  readonly name: string
  /** The tool's input, truncated: a Bash command or a file write can carry
   *  anything, and this record is served to a browser. */
  readonly input: string
  is_error?: boolean
  result_chars?: number
}

/** Every event: a type and whatever the line carried that matters. */
export interface StreamEvent {
  readonly type: string
  readonly [key: string]: unknown
}

export interface ModelCallCompleted extends StreamEvent {
  readonly type: 'model_call.completed'
  readonly index: number
  readonly message_id: string
  /** The Agent call this is a subagent's reply to, or null on the main thread. */
  readonly parent_tool_use_id: string | null
  readonly model?: string
  readonly stop_reason?: string
  readonly text_chars: number
  readonly tool_uses: ToolUse[]
  /**
   * The usage on the message's first block, which is a message-start
   * snapshot: `output_tokens` reads a handful per call while the `result`
   * line's total is in the thousands. Input and cache figures are usable;
   * the real per-call output figure is in the session transcript.
   */
  readonly usage?: unknown
}

export type ReducedEvent = StreamEvent

/** Long enough to recognise a command or a path, short enough to never be
 *  the whole of a file write. */
const INPUT_MAX = 160

const summarise = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > INPUT_MAX ? `${text.slice(0, INPUT_MAX - 3)}...` : text
}

type Line = Record<string, unknown>

const record = (value: unknown): Line =>
  typeof value === 'object' && value !== null ? (value as Line) : {}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

interface OpenCall {
  index: number
  message_id: string
  parent_tool_use_id: string | null
  model?: string
  stop_reason?: string
  text_chars: number
  tool_uses: ToolUse[]
  usage?: unknown
}

export class StreamReducer {
  /** Open calls by message id. */
  private readonly open = new Map<string, OpenCall>()
  /** The open message on each thread, by parent tool-use id (null = main). */
  private readonly current = new Map<string | null, string>()
  private count = 0
  private invocations = 0
  private results = 0

  constructor(private readonly emit: (event: ReducedEvent) => void) {}

  push(line: string): void {
    if (!line.startsWith('{')) return
    let obj: Line
    try {
      obj = JSON.parse(line) as Line
    } catch {
      return
    }
    switch (obj.type) {
      case 'system':
        this.system(obj)
        return
      case 'assistant':
        this.assistant(obj)
        return
      case 'user':
        this.user(obj)
        return
      case 'result':
        this.flushAll()
        this.results += 1
        this.emit({
          type: 'invocation.finished',
          invocation: this.results,
          subtype: obj.subtype,
          is_error: obj.is_error,
          num_turns: obj.num_turns,
          duration_ms: obj.duration_ms,
          duration_api_ms: obj.duration_api_ms,
          total_cost_usd: obj.total_cost_usd,
          usage: obj.usage,
        })
        return
      case 'rate_limit_event': {
        // The subscription's own windows, reported by Claude Code on every
        // run. This is what a Limit Gate would read, and it arrives on the
        // stream rather than having to be inferred from failures.
        const info = record(obj.rate_limit_info)
        const windows = record(info.unifiedWindows)
        this.emit({
          type: 'rate_limit',
          status: info.status,
          window: info.rateLimitType,
          resets_at: info.resetsAt,
          five_hour: windows.five_hour,
          seven_day: windows.seven_day,
        })
        return
      }
      default:
        this.emit({ type: 'other', line_type: obj.type, subtype: obj.subtype })
    }
  }

  /** The stream ended without a `result` line — a session that was killed,
   *  or a stream that broke. Whatever is still open is reported as it was. */
  end(): void {
    this.flushAll()
  }

  private system(obj: Line): void {
    switch (obj.subtype) {
      case 'init': {
        this.invocations += 1
        this.emit({
          type: this.invocations === 1 ? 'session.started' : 'session.resumed',
          invocation: this.invocations,
          session_id: obj.session_id,
          model: obj.model,
          cwd: obj.cwd,
          tools: Array.isArray(obj.tools) ? obj.tools.length : undefined,
        })
        return
      }
      // A background subagent is a "task" to the stream: started with the
      // Agent call's tool-use id and its own task id (the same id the hooks
      // report as `agent_id`), progress with running totals, and a
      // notification when it is done.
      case 'task_started':
        this.emit({
          type: 'subagent.started',
          task_id: obj.task_id,
          tool_use_id: obj.tool_use_id,
          subagent_type: obj.subagent_type,
          description: obj.description,
          backgrounded: obj.is_backgrounded,
        })
        return
      case 'task_progress': {
        const usage = record(obj.usage)
        this.emit({
          type: 'subagent.progress',
          task_id: obj.task_id,
          tool_uses: usage.tool_uses,
          total_tokens: usage.total_tokens,
          duration_ms: usage.duration_ms,
          last_tool_name: obj.last_tool_name,
        })
        return
      }
      case 'task_notification': {
        // The moment the child's thread can be closed: its final message has
        // no successor on that thread to close it.
        const parent = str(obj.tool_use_id)
        const open = parent === undefined ? undefined : this.current.get(parent)
        if (open !== undefined) this.flush(open)
        this.emit({
          type: 'subagent.finished',
          task_id: obj.task_id,
          tool_use_id: obj.tool_use_id,
          status: obj.status,
          summary_chars: typeof obj.summary === 'string' ? obj.summary.length : undefined,
        })
        return
      }
      default:
        this.emit({ type: 'system', subtype: obj.subtype })
    }
  }

  private assistant(obj: Line): void {
    const message = record(obj.message)
    const id = str(message.id) ?? `anon-${this.count}`
    const thread = str(obj.parent_tool_use_id) ?? null
    let call = this.open.get(id)
    if (!call) {
      // A new message on this thread closes the thread's previous one.
      const previous = this.current.get(thread)
      if (previous !== undefined && previous !== id) this.flush(previous)
      this.count += 1
      call = {
        index: this.count,
        message_id: id,
        parent_tool_use_id: thread,
        model: str(message.model),
        text_chars: 0,
        tool_uses: [],
      }
      this.open.set(id, call)
      this.current.set(thread, id)
    }
    const stop = str(message.stop_reason)
    if (stop !== undefined) call.stop_reason = stop
    if (message.usage !== undefined) call.usage = message.usage
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content.map(record)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        call.text_chars += block.text.length
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        call.tool_uses.push({
          id: block.id,
          name: String(block.name),
          input: summarise(block.input),
        })
      }
    }
  }

  private user(obj: Line): void {
    const message = record(obj.message)
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content.map(record)) {
      if (block.type !== 'tool_result') continue
      // Whichever open call issued it — the Agent call's own result lands
      // long after the parent has moved on to other messages.
      let use: ToolUse | undefined
      for (const call of this.open.values()) {
        use = call.tool_uses.find((u) => u.id === block.tool_use_id)
        if (use) break
      }
      if (!use) continue
      use.is_error = block.is_error === true
      const body = block.content
      use.result_chars =
        typeof body === 'string'
          ? body.length
          : Array.isArray(body)
            ? JSON.stringify(body).length
            : 0
    }
  }

  private flush(messageId: string): void {
    const call = this.open.get(messageId)
    if (!call) return
    this.emit({ type: 'model_call.completed', ...call })
    this.open.delete(messageId)
    if (this.current.get(call.parent_tool_use_id) === messageId) {
      this.current.delete(call.parent_tool_use_id)
    }
  }

  private flushAll(): void {
    // Deleting the current key while iterating a Map is defined behaviour.
    for (const id of this.open.keys()) this.flush(id)
  }
}

/** Replay a whole stream — a captured file, or a test's lines — and collect
 *  what it reduces to. Ends the stream, so open calls are included. */
export const reduceStream = (lines: Iterable<string>): ReducedEvent[] => {
  const events: ReducedEvent[] = []
  const reducer = new StreamReducer((event) => events.push(event))
  for (const line of lines) reducer.push(line)
  reducer.end()
  return events
}
