import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { reduceStream, StreamReducer, type ModelCallCompleted } from './reducer.js'

/**
 * A real `stream-json` capture from the PoC behind #43: one Claude Code
 * session that delegated research to a background subagent, was woken up by
 * its result, and finished. The facts below are the ones the reducer exists
 * to get right, and every one of them was observed in that run.
 */
const fixture = readFileSync(new URL('./fixtures/subagent-run.jsonl', import.meta.url), 'utf8')

const events = reduceStream(fixture.split('\n'))
const ofType = (type: string) => events.filter((e) => e.type === type)
const calls = ofType('model_call.completed') as ModelCallCompleted[]

const AGENT_CALL = 'toolu_01SANsnZWD7seotAxZbLKrzi'
const TASK = 'a96f8c808c316a2d5'
const SESSION = '05097161-29be-44b1-ad49-65e915f08d3f'

describe('reduceStream over a captured subagent run', () => {
  // A background subagent re-invokes the parent when it finishes: two `init`
  // lines for one session id, the second one a resume rather than a start.
  it('tells the first init from the re-invocation, on the same session', () => {
    expect(ofType('session.started')).toEqual([
      expect.objectContaining({ invocation: 1, session_id: SESSION, model: 'claude-sonnet-5' }),
    ])
    expect(ofType('session.resumed')).toEqual([
      expect.objectContaining({ invocation: 2, session_id: SESSION }),
    ])
  })

  // Both `result` lines arrive together at the very end, after the last
  // `init` — numbered on their own counter, or both would read as invocation 2.
  it('numbers the invocation results on their own counter', () => {
    const results = ofType('invocation.finished')
    expect(results.map((r) => r.invocation)).toEqual([1, 2])
    expect(results.map((r) => r.num_turns)).toEqual([3, 6])
    // The session total, repeated on each — not a per-invocation figure.
    expect(results.map((r) => r.total_cost_usd)).toEqual([0.1631434, 0.1631434])
  })

  it('folds the stream into one event per model call, numbered in order of first block', () => {
    expect(calls).toHaveLength(12)
    expect(calls.map((c) => c.index).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
    expect(new Set(calls.map((c) => c.message_id)).size).toBe(12)
  })

  it("marks a subagent's calls with the Agent call that spawned it", () => {
    const sub = calls.filter((c) => c.parent_tool_use_id === AGENT_CALL)
    expect(sub.map((c) => c.index)).toEqual([2, 4, 6])
    expect(calls.filter((c) => c.parent_tool_use_id === null)).toHaveLength(9)
  })

  // The child's four tool-use blocks for one message arrived with parent
  // messages in between. A "last message" rule split this call in two.
  it('keeps a call whole when its blocks interleave with another thread', () => {
    const interleaved = calls.find((c) => c.message_id === 'msg_011CfNcCH4jL2ajGDwo3NK6L')
    expect(interleaved?.tool_uses.map((u) => u.name)).toEqual(['Read', 'Read', 'Read', 'Bash'])
    expect(interleaved?.tool_uses.map((u) => u.result_chars)).toEqual([109, 87, 87, 287])
  })

  it('attaches each tool result to the call that issued it, wherever it lands', () => {
    const first = calls.find((c) => c.index === 1)
    expect(first?.tool_uses).toEqual([
      expect.objectContaining({ name: 'Agent', is_error: false, result_chars: 1079 }),
    ])
    const wakeup = calls.find((c) => c.index === 3)
    expect(wakeup?.tool_uses).toEqual([
      expect.objectContaining({ name: 'ScheduleWakeup', is_error: true, result_chars: 45 }),
    ])
  })

  // The usage on an `assistant` line is the message-start snapshot: a
  // handful of output tokens per call, against a result total in the
  // thousands. Kept as what it is, and never presented as the real figure.
  it('carries per-call usage as the snapshot it is, not as the real output figure', () => {
    const outputs = calls.map((c) => (c.usage as { output_tokens: number }).output_tokens)
    expect(outputs.every((n) => n <= 16)).toBe(true)
    const total = ofType('invocation.finished').map(
      (r) => (r.usage as { output_tokens: number }).output_tokens,
    )
    expect(Math.max(...total)).toBeGreaterThan(1000)
  })

  it('truncates tool input, so a secret-carrying argument is never copied whole', () => {
    for (const use of calls.flatMap((c) => c.tool_uses)) {
      expect(use.input.length).toBeLessThanOrEqual(160)
    }
  })

  // The subagent's final message is text only, and nothing else ever arrives
  // on its thread — its task notification is what closes it.
  it("closes a subagent's last call on its task notification", () => {
    const finished = events.findIndex((e) => e.type === 'subagent.finished')
    const last = events.findIndex(
      (e) => e.type === 'model_call.completed' && (e as ModelCallCompleted).index === 6,
    )
    expect(last).toBeGreaterThan(-1)
    expect(last).toBeLessThan(finished)
    expect(events[finished]).toEqual(
      expect.objectContaining({ task_id: TASK, tool_use_id: AGENT_CALL, status: 'completed' }),
    )
  })

  // `task_id` here is what the hooks report as `agent_id`; `tool_use_id` is
  // the child's `parent_tool_use_id`. Both are what joins the sources.
  it('carries the ids that join the stream to the hooks', () => {
    expect(ofType('subagent.started')).toEqual([
      expect.objectContaining({
        task_id: TASK,
        tool_use_id: AGENT_CALL,
        subagent_type: 'Explore',
        backgrounded: true,
      }),
    ])
    expect(ofType('subagent.progress').length).toBeGreaterThan(0)
    for (const p of ofType('subagent.progress')) {
      expect(p).toEqual(expect.objectContaining({ task_id: TASK, tool_use_id: AGENT_CALL }))
    }
  })

  it("surfaces the subscription's windows from the rate limit line", () => {
    expect(ofType('rate_limit')).toEqual([
      expect.objectContaining({
        status: 'allowed',
        window: 'five_hour',
        five_hour: { utilization: 0.12, resetsAt: 1790269800 },
        seven_day: { utilization: 0.24, resetsAt: 1790427600 },
      }),
    ])
  })

  it('keeps the other system subtypes as quiet system events', () => {
    const subtypes = new Set(ofType('system').map((e) => e.subtype))
    expect(subtypes).toContain('hook_started')
    expect(subtypes).toContain('background_tasks_changed')
    expect(subtypes).not.toContain('init')
    expect(subtypes).not.toContain('task_started')
  })
})

describe('StreamReducer', () => {
  it('ignores what is not a JSON object line', () => {
    const seen: unknown[] = []
    const reducer = new StreamReducer((e) => seen.push(e))
    reducer.push('')
    reducer.push('Starting agent...')
    reducer.push('{not json')
    expect(seen).toEqual([])
  })

  it('reports an unknown line type rather than dropping it', () => {
    expect(reduceStream(['{"type":"mystery","subtype":"x"}'])).toEqual([
      { type: 'other', line_type: 'mystery', subtype: 'x' },
    ])
  })

  // Nothing ever closes the last call on the main thread but the result
  // line; a session that dies without one still reports its open calls.
  it('flushes every open call when told the stream ended', () => {
    const seen: { type: string }[] = []
    const reducer = new StreamReducer((e) => seen.push(e))
    reducer.push(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }] },
      }),
    )
    expect(seen).toEqual([])
    reducer.end()
    expect(seen.map((e) => e.type)).toEqual(['model_call.completed'])
  })
})
