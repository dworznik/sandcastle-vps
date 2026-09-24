/**
 * PoC: one unattended Claude Code session under sandcastle, observed three
 * ways, everything rendered as JSON lines on stdout.
 *
 *   pnpm tsx scripts/poc/agent-events.ts "add a function that parses ISO-8601 durations"
 *   pnpm tsx scripts/poc/agent-events.ts "..." --model claude-opus-4-8 | jq -c 'select(.source=="stream")'
 *
 * What it does, in order:
 *
 *   1. Scaffolds a throwaway Python project under `.poc/<name>` (gitignored):
 *      a git checkout with a `.sandcastle/Dockerfile` that adds python3 to
 *      sandcastle's stock image. Builds the image once, through the same
 *      `ensureSandboxImage` the Harness uses.
 *   2. Prepends a fixed system prompt to the feature prompt given on the
 *      command line. sandcastle exposes no separate system-prompt channel, so
 *      the two travel as one prompt; a Project's CLAUDE.md is the other place
 *      such instructions could live.
 *   3. Starts a Run with `run()` from the sandcastle API, on a fresh branch
 *      cut from `main`, and watches it from both sides of the Sandbox wall:
 *
 *      - `source: "stream"` — the Harness side. Every raw stdout line of
 *        `claude --print --output-format stream-json` arrives through
 *        `onAgentStreamEvent`, and a small reducer folds them into one event
 *        per model call (Claude Code's "turn"): the tool calls it issued, their
 *        results, and the usage snapshot on its assistant lines.
 *
 *        A finding from running this: that snapshot is the one taken at the
 *        start of the message, so its `output_tokens` is a handful per call
 *        while the `result` line's total is in the thousands. Per-call output
 *        usage needs another source — the captured session JSONL, or Claude
 *        Code's OpenTelemetry events. Input and cache figures are usable.
 *      - `source: "hook"` — the Claude Code side. A sandbox `onSandboxReady`
 *        hook writes user-scope Claude Code hooks into the Sandbox that append
 *        one JSON line per SessionStart / PreToolUse / PostToolUse / Stop /
 *        SessionEnd to a file on a bind mount. This process tails that file.
 *      - `source: "poc"` — this process: the phases around the agent
 *        (scaffold, image, run, result), which is where a Harness would also
 *        put Delivery.
 *
 * Human-readable progress goes to stderr; stdout is JSONL only, so the output
 * pipes straight into `jq` or a file. The full stream-json also lands in the
 * Run's log under the project's `.sandcastle/logs/`, and the hook lines under
 * `.sandcastle/poc-events/<stamp>/`, so nothing here is the only copy.
 *
 * Credentials: `CLAUDE_CODE_OAUTH_TOKEN` if set, else `ANTHROPIC_API_KEY`,
 * passed into the Sandbox through the docker provider's env, the same channel
 * the Harness uses. Nothing is written into the scratch project.
 */
import { execFile } from 'node:child_process'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { existsSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { claudeCode, run, type AgentStreamEvent } from '@ai-hero/sandcastle'
import { docker, defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker'
import { ensureSandboxImage } from '../../src/image.js'

const exec = promisify(execFile)

// ------------------------------------------------------------------ output

type Source = 'poc' | 'stream' | 'hook'

/**
 * One JSON line on stdout. Everything this tool observes goes through here.
 *
 * Written to file descriptor 1 directly, because `process.stdout` is
 * redirected below: sandcastle prints a start banner through it even in
 * log-to-file mode, and a banner in the middle of a JSONL stream breaks the
 * `jq` on the other end of the pipe.
 */
const emit = (source: Source, type: string, data: Record<string, unknown> = {}): void => {
  writeSync(1, `${JSON.stringify({ t: new Date().toISOString(), ...data, source, type })}\n`)
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

// Everything else that reaches stdout goes to stderr instead.
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
  (process.stderr.write as (...args: unknown[]) => boolean)(
    chunk,
    ...rest,
  )) as typeof process.stdout.write

// ------------------------------------------------------------ the prompts

/**
 * The instructions every feature prompt is wrapped in. Short on purpose: the
 * point of the PoC is the observation, not the agent's craft.
 */
const SYSTEM_PROMPT = `You are implementing one feature in a small Python project, unattended.

Rules:
- Python 3 only, standard library only, no third-party packages.
- Put the implementation under \`src/\` and tests under \`tests/\` using \`unittest\`.
- Run the tests with \`python3 -m unittest discover -s tests\` and make them pass.
- Commit your work with a conventional commit message. Do not push; there is no remote.
- Do not ask questions. If the feature is ambiguous, make a reasonable choice and note it in the commit body.
- When the work is committed and the tests pass, stop.`

const composePrompt = (feature: string): string => `${SYSTEM_PROMPT}\n\n## Feature\n\n${feature}\n`

// ------------------------------------------------------ scratch project

/**
 * sandcastle's stock Dockerfile, plus python3. The UID/GID build-args and the
 * `agent` user are what sandcastle's bind mounts rely on, so those lines are
 * kept exactly as `sandcastle init` writes them.
 */
const DOCKERFILE = `FROM node:22-bookworm

RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  python3 \\
  python3-venv \\
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

ENTRYPOINT ["sleep", "infinity"]
`

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'poc',
      GIT_AUTHOR_EMAIL: 'poc@example.invalid',
      GIT_COMMITTER_NAME: 'poc',
      GIT_COMMITTER_EMAIL: 'poc@example.invalid',
    },
  })
  return stdout.trim()
}

/** A checkout the agent can work in: one commit on `main`, a Dockerfile, and
 *  an author identity for sandcastle to copy into the Sandbox. */
const scaffoldProject = async (path: string): Promise<{ readonly created: boolean }> => {
  if (existsSync(join(path, '.git'))) return { created: false }
  await mkdir(join(path, '.sandcastle'), { recursive: true })
  await writeFile(join(path, '.sandcastle', 'Dockerfile'), DOCKERFILE)
  await writeFile(
    join(path, '.gitignore'),
    '.sandcastle/worktrees/\n.sandcastle/logs/\n.sandcastle/poc-events/\n__pycache__/\n',
  )
  await writeFile(
    join(path, 'README.md'),
    '# poc\n\nA scratch Python project for `scripts/poc/agent-events.ts`. Each run lands on its own branch.\n',
  )
  await mkdir(join(path, 'src'), { recursive: true })
  await mkdir(join(path, 'tests'), { recursive: true })
  await writeFile(join(path, 'src', '__init__.py'), '')
  await writeFile(join(path, 'tests', '__init__.py'), '')
  await git(path, ['init', '-q', '-b', 'main'])
  await git(path, ['config', 'user.name', 'poc'])
  await git(path, ['config', 'user.email', 'poc@example.invalid'])
  await git(path, ['add', '-A'])
  await git(path, ['commit', '-q', '-m', 'chore: scaffold'])
  return { created: true }
}

// ------------------------------------------------- Claude Code hooks

/** Where the Sandbox sees the events directory this process tails. */
const SANDBOX_EVENTS_DIR = '/sandcastle-events'
const HOOKS_FILE = 'hooks.jsonl'

/**
 * The hook command Claude Code runs in the Sandbox for each event, with the
 * event's JSON on stdin. It keeps the fields that identify the step and
 * truncates the two that can be arbitrarily large, so one line stays one
 * line. `tool_response` is reduced to its size: its shape differs per tool.
 */
const HOOK_COMMAND =
  `jq -c '{t: (now | todate), event: .hook_event_name, session_id, tool_name, tool_use_id, ` +
  `tool_input: ((.tool_input // null) | tojson | .[0:160]), ` +
  `response_bytes: ((.tool_response // null) | tojson | length), ` +
  `start_source: .source, end_reason: .reason} | with_entries(select(.value != null))' ` +
  `>> ${SANDBOX_EVENTS_DIR}/${HOOKS_FILE}`

const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']

const hookSettings = (): string =>
  JSON.stringify({
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }],
      ]),
    ),
  })

/**
 * Runs in the Sandbox as the agent user, after sandcastle's own setup and
 * before the agent starts — the same slot the Harness uses for git config.
 * User-scope settings rather than the worktree's `.claude/`, so nothing about
 * observation lands in the project or depends on workspace trust.
 */
const installHooksCommand = (): string => `set -eu
mkdir -p ~/.claude
if [ -f ~/.claude/settings.json ]; then
  jq -s '.[0] * .[1]' ~/.claude/settings.json - > ~/.claude/settings.json.new <<'EOF'
${hookSettings()}
EOF
  mv ~/.claude/settings.json.new ~/.claude/settings.json
else
  cat > ~/.claude/settings.json <<'EOF'
${hookSettings()}
EOF
fi`

/**
 * Tail a file that another process appends whole lines to. Polling rather
 * than `fs.watch`: the writer is a container on a bind mount, and inotify
 * across that boundary is not something to rely on in a PoC.
 */
const tailJsonl = (path: string, onLine: (line: string) => void) => {
  let offset = 0
  let partial = ''
  const drain = async (): Promise<void> => {
    if (!existsSync(path)) return
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      if (size <= offset) return
      const buffer = Buffer.alloc(size - offset)
      await handle.read(buffer, 0, buffer.length, offset)
      offset = size
      const chunks = (partial + buffer.toString('utf8')).split('\n')
      partial = chunks.pop() ?? ''
      for (const line of chunks) if (line.trim()) onLine(line)
    } finally {
      await handle.close()
    }
  }
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    drain()
      .catch((error: unknown) => say(`hook tail: ${String(error)}`))
      .finally(() => {
        busy = false
      })
  }, 250)
  return {
    stop: async (): Promise<void> => {
      clearInterval(timer)
      await drain()
    },
  }
}

// ------------------------------------------- stream-json → model calls

interface ToolUse {
  id: string
  name: string
  input: string
  is_error?: boolean
  result_chars?: number
}

interface ModelCall {
  index: number
  message_id: string
  parent_tool_use_id: string | null
  model?: string
  stop_reason?: string
  text_chars: number
  tool_uses: ToolUse[]
  usage?: unknown
}

const summarise = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/**
 * Folds Claude Code's stream into one event per model call.
 *
 * The stream carries one `assistant` line per content block, all sharing the
 * message id of the call that produced them, then a `user` line with the
 * tool results. A call is complete only when the next call starts or the
 * `result` line arrives, because its results trail it — so that is when the
 * event is emitted.
 */
class ModelCallReducer {
  private pending: ModelCall | undefined
  private count = 0

  push(line: string): void {
    if (!line.startsWith('{')) return
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
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
        this.flush()
        emit('stream', 'session.finished', {
          subtype: obj.subtype,
          is_error: obj.is_error,
          num_turns: obj.num_turns,
          duration_ms: obj.duration_ms,
          duration_api_ms: obj.duration_api_ms,
          total_cost_usd: obj.total_cost_usd,
          usage: obj.usage,
        })
        return
      default:
        emit('stream', 'other', { line_type: obj.type, subtype: obj.subtype })
    }
  }

  private system(obj: Record<string, unknown>): void {
    if (obj.subtype === 'init') {
      const tools = Array.isArray(obj.tools) ? obj.tools.length : undefined
      emit('stream', 'session.started', {
        session_id: obj.session_id,
        model: obj.model,
        cwd: obj.cwd,
        tools,
      })
      return
    }
    emit('stream', 'system', { subtype: obj.subtype })
  }

  private assistant(obj: Record<string, unknown>): void {
    const message = (obj.message ?? {}) as Record<string, unknown>
    const id = typeof message.id === 'string' ? message.id : `anon-${this.count}`
    if (this.pending?.message_id !== id) {
      this.flush()
      this.count += 1
      this.pending = {
        index: this.count,
        message_id: id,
        parent_tool_use_id:
          typeof obj.parent_tool_use_id === 'string' ? obj.parent_tool_use_id : null,
        model: typeof message.model === 'string' ? message.model : undefined,
        text_chars: 0,
        tool_uses: [],
      }
    }
    const call = this.pending
    if (typeof message.stop_reason === 'string') call.stop_reason = message.stop_reason
    if (message.usage !== undefined) call.usage = message.usage
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content as Record<string, unknown>[]) {
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

  private user(obj: Record<string, unknown>): void {
    const message = (obj.message ?? {}) as Record<string, unknown>
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result') continue
      const use = this.pending?.tool_uses.find((u) => u.id === block.tool_use_id)
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

  private flush(): void {
    if (!this.pending) return
    emit('stream', 'model_call.completed', { ...this.pending })
    this.pending = undefined
  }
}

// ---------------------------------------------------------------- main

const usage = (): never => {
  say(
    'Usage: pnpm tsx scripts/poc/agent-events.ts "<feature prompt>" [--model <id>] [--name <project>] [--workspace <dir>]',
  )
  process.exit(2)
}

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string', default: process.env.AGENT_MODEL ?? 'claude-sonnet-5' },
      name: { type: 'string', default: 'python-feature' },
      workspace: { type: 'string' },
    },
  })
  const feature = positionals.join(' ').trim()
  if (!feature) usage()

  // Path parity: the Sandbox's bind mounts are created by the Docker daemon,
  // so the project has to live somewhere the daemon sees at the same path.
  // The repo checkout is such a place; a system temp dir may not be.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const workspace = resolve(values.workspace ?? join(repoRoot, '.poc'))
  const path = join(workspace, values.name)
  const project = { name: values.name, path, imageName: defaultImageName(path) }

  const credentials: Record<string, string> = process.env.CLAUDE_CODE_OAUTH_TOKEN
    ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    : process.env.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
      : {}
  if (Object.keys(credentials).length === 0) {
    say('Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY for the agent.')
    process.exit(2)
  }

  const stamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z')
  const branch = `poc/${stamp.toLowerCase()}`
  const eventsDir = join(path, '.sandcastle', 'poc-events', stamp)
  const logPath = join(path, '.sandcastle', 'logs', `${stamp}.log`)

  say(`project   ${path}`)
  const { created } = await scaffoldProject(path)
  emit('poc', 'project.ready', { path, created })

  say(`image     ${project.imageName}${created ? ' (building)' : ''}`)
  const { built } = await ensureSandboxImage(project)
  emit('poc', 'image.ready', { imageName: project.imageName, built })

  await mkdir(eventsDir, { recursive: true })
  await mkdir(dirname(logPath), { recursive: true })
  const tail = tailJsonl(join(eventsDir, HOOKS_FILE), (line) => {
    try {
      emit('hook', 'claude', JSON.parse(line) as Record<string, unknown>)
    } catch {
      emit('hook', 'unparsed', { line })
    }
  })

  const reducer = new ModelCallReducer()
  say(`branch    ${branch}`)
  say(`model     ${values.model}`)
  say(`log       ${logPath}`)
  emit('poc', 'run.started', { branch, model: values.model, feature })
  const startedAt = Date.now()
  try {
    const result = await run({
      cwd: path,
      prompt: composePrompt(feature),
      agent: claudeCode(values.model),
      sandbox: docker({
        imageName: project.imageName,
        env: credentials,
        mounts: [{ hostPath: eventsDir, sandboxPath: SANDBOX_EVENTS_DIR }],
      }),
      hooks: { sandbox: { onSandboxReady: [{ command: installHooksCommand() }] } },
      branchStrategy: { type: 'branch', branch, baseBranch: 'main' },
      name: `poc:${branch}`,
      logging: {
        type: 'file',
        path: logPath,
        onAgentStreamEvent: (event: AgentStreamEvent) => {
          if (event.type === 'raw') reducer.push(event.line)
        },
      },
    })
    await tail.stop()
    emit('poc', 'run.finished', {
      branch: result.branch,
      commits: result.commits.map((c) => c.sha),
      duration_ms: Date.now() - startedAt,
      completionSignal: result.completionSignal,
      logFilePath: result.logFilePath,
      sessionFilePath: result.iterations.at(-1)?.sessionFilePath,
      usage: result.iterations.at(-1)?.usage,
      preservedWorktreePath: result.preservedWorktreePath,
    })
    say(`done      ${result.commits.length} commit(s) on ${result.branch}`)
  } catch (error) {
    await tail.stop()
    emit('poc', 'run.failed', {
      branch,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    say(`failed    ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

await main()
