import { describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import {
  addProject,
  cloneScript,
  onboardScript,
  parseProjects,
  projectNameFor,
  pushAccessScript,
  validateProjectName,
  type OnboardSession,
} from './onboard.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

describe('projectNameFor', () => {
  it('names the Project after the repository, which is also its image suffix', () => {
    expect(projectNameFor('dworznik/sandcastle-todo-app')).toBe('sandcastle-todo-app')
    expect(projectNameFor('https://github.com/dworznik/todo.git')).toBe('todo')
    expect(projectNameFor('git@github.com:dworznik/todo.git')).toBe('todo')
  })
})

describe('validateProjectName', () => {
  // The same rule resolveProject applies on the Harness side: a name that
  // cannot resolve there is a name that must not be Onboarded here.
  it('refuses anything that is not a plain directory name', () => {
    for (const name of ['../etc', 'a/b', '..', '.', '/abs', '', 'has space']) {
      expect(() => validateProjectName(name)).toThrow(/Invalid Project name/)
    }
  })

  // `git clone <url> -foo` reads that as an option, whatever the shell quoting
  // around it did — quoting protects the shell, not the program it runs.
  it('refuses a leading dash, which git would read as an option', () => {
    expect(() => validateProjectName('-foo')).toThrow(/Invalid Project name/)
    expect(() => validateProjectName('--upload-pack=x')).toThrow(/Invalid Project name/)
  })

  it('takes the names a repository actually has', () => {
    for (const name of ['todo-app', 'sandcastle_vps', 'app.v2']) {
      expect(validateProjectName(name)).toBe(name)
    }
  })
})

describe('cloneScript', () => {
  const script = cloneScript('https://github.com/dworznik/todo.git', 'todo')

  // The whole reason Onboarding runs in the container. The token is named, not
  // carried: this CLI never sees it, so there is nothing here to leak.
  it('names the token rather than carrying one', () => {
    expect(script).toContain('$GH_TOKEN')
    expect(script).not.toMatch(/gh[ps]_|github_pat_/u)
  })

  // `-c` config is command-line only. A token written into the checkout's
  // config would be a copy of a credential the Harness already holds, sitting
  // in a directory the operator commits from.
  it('passes the credential helper as command-line config, not into the checkout', () => {
    expect(script).toContain('-c credential.helper=')
    expect(script).not.toContain('git config')
  })

  it('leaves the remote HTTPS, which is how a Sandbox pushes later', () => {
    expect(script).toContain('https://github.com/dworznik/todo.git')
    expect(script).not.toContain('git@')
  })

  // There is no terminal in that container to answer a prompt on, so a repo
  // the token cannot reach has to fail rather than wait.
  it('cannot be made to wait for a credential prompt', () => {
    expect(script).toContain('GIT_TERMINAL_PROMPT=0')
  })

  it('quotes what it was handed rather than pasting it into a command', () => {
    expect(cloneScript('https://example.com/x.git', "o'brien")).toContain(`'o'\\''brien'`)
  })

  // A directory that is there but is not a checkout cannot be Onboarded:
  // scaffolding .sandcastle/ into it produces a Project every Run then fails
  // on, for a reason nothing here would have explained.
  it('tells an existing checkout apart from an existing directory', () => {
    expect(script).toContain('/.git')
    expect(script).toContain('is not a git checkout')
  })
})

describe('onboardScript', () => {
  const script = onboardScript('todo')

  it('scaffolds the blank template through the real sandcastle CLI', () => {
    expect(script).toContain('sandcastle init')
    expect(script).toContain('--template blank')
  })

  it("appends this stack's extras to the scaffolded Dockerfile", () => {
    expect(script).toContain('extras.Dockerfile >> .sandcastle/Dockerfile')
  })

  // `sandcastle init` ignores logs/ and worktrees/; the run directories a Run
  // keeps beside them would otherwise show as untracked in every checkout.
  it('ignores the run directories in the scaffolded .gitignore', () => {
    expect(script).toContain('>> .sandcastle/.gitignore')
    expect(script).toMatch(/runs\/.*>> \.sandcastle\/\.gitignore/u)
  })

  // A Project carries no credentials (ADR 0006); a stale copy of a token the
  // Harness already holds is worse than none.
  it('writes no .env into the Project', () => {
    expect(script).not.toContain('.env')
  })
})

describe('parseProjects', () => {
  it('reads the list the Harness answered with', () => {
    const body = JSON.stringify({ projects: [{ name: 'todo', onboarded: true }] })
    expect(parseProjects(body)).toEqual([{ name: 'todo', onboarded: true }])
  })

  // A body that is not JSON came from docker or curl, not the Harness, and
  // reporting it as "no Projects" would read as a working Target with none.
  it('raises what came back when it is not a list of Projects', () => {
    expect(() => parseProjects('curl: (7) Failed to connect')).toThrow(/did not answer/)
    expect(() => parseProjects('{"error":"nope"}')).toThrow(/no list of Projects/)
  })
})

describe('pushAccessScript', () => {
  const script = pushAccessScript('dworznik/todo')

  // Same rule as the clone: the token is named, never carried.
  it('names the token rather than carrying one', () => {
    expect(script).toContain('$GH_TOKEN')
    expect(script).not.toMatch(/gh[ps]_|github_pat_/u)
  })

  // The Harness image has curl and not the GitHub CLI.
  it('uses curl, which the Harness image actually has', () => {
    expect(script).toContain('curl')
    expect(script).not.toMatch(/\bgh api\b/u)
  })

  it('puts the token in a header, not on the command line', () => {
    expect(script).toContain('Authorization: Bearer $GH_TOKEN')
  })

  it('quotes the repository rather than pasting it into a command', () => {
    expect(pushAccessScript("o'brien/x")).toContain(`'o'\\''brien/x'`)
  })
})

// ------------------------------------------------------------------- the flow

interface Ran {
  readonly script: string
  readonly stdin: string
}

const projectsBody = (projects: unknown[]): string => JSON.stringify({ projects })

const fakeConnector = (options: {
  before?: unknown[]
  after?: unknown[]
  buildCode?: number
  push?: string
}) => {
  const ran: Ran[] = []
  let listed = 0
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      const stdin = typeof opts?.stdin === 'string' ? opts.stdin : ''
      ran.push({ script, stdin })
      const ok = (stdout: string, code = 0): Promise<ExecResult> =>
        Promise.resolve({ code, stdout, stderr: '' })
      if (script.includes('/.env')) return ok('WORKSPACE_ROOT=/home/op/work\n')
      // The list is asked once, before anything is changed; the by-name route
      // is the final check, and answers 404-shaped when it cannot resolve.
      if (script.includes('/projects/')) {
        const after = options.after ?? [
          { name: 'todo', imageName: 'sandcastle:todo', onboarded: true },
        ]
        const found = (after as { name?: string }[]).find((p) => p.name === 'todo')
        return ok(
          found
            ? JSON.stringify(found)
            : JSON.stringify({ error: 'Project "todo" has not been Onboarded' }),
        )
      }
      if (script.includes('/projects')) {
        listed += 1
        return ok(
          projectsBody(
            options.before ?? [{ name: 'todo', imageName: 'sandcastle:todo', onboarded: true }],
          ),
        )
      }
      if (stdin.includes('api.github.com/repos')) return ok(`push\t${options.push ?? 'true'}`)
      if (stdin.includes('clone')) return ok('state\tcloned')
      if (stdin.includes('sandcastle init')) return ok('state\tonboarded')
      if (stdin.includes('build-image')) return ok('', options.buildCode ?? 0)
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, ran }
}

const fakePrompter = (answers: string[], confirmAnyway = false) => {
  const asked: string[] = []
  const queue = [...answers]
  const prompter: Prompter = {
    text: (question, fallback) => {
      asked.push(question)
      return Promise.resolve(queue.shift() ?? fallback ?? '')
    },
    secret: () => Promise.reject(new Error('Onboarding asks for no secret')),
    select: <T>(_q: string, choices: readonly Choice<T>[]) =>
      Promise.resolve(choices[0]?.value as T),
    multi: <T>(_q: string, choices: readonly Choice<T>[]) =>
      Promise.resolve(choices.map((choice) => choice.value)),
    confirm: (question, fallback = false) => {
      asked.push(question)
      return Promise.resolve(question.includes('anyway') ? confirmAnyway : fallback)
    },
    close: () => {},
  }
  return { prompter, asked }
}

const run = async (
  answers: string[],
  options: {
    before?: unknown[]
    after?: unknown[]
    buildCode?: number
    push?: string
    confirmAnyway?: boolean
  } = {},
) => {
  const { connector, ran } = fakeConnector(options)
  const { prompter, asked } = fakePrompter(answers, options.confirmAnyway ?? false)
  const session: OnboardSession = { profile, connector, prompter }
  const lines: string[] = []
  let result: Awaited<ReturnType<typeof addProject>>
  let failure: unknown
  try {
    result = await addProject(session, (line) => lines.push(line))
  } catch (error) {
    failure = error
  }
  return { result, failure, ran, asked, shown: lines.join('\n') }
}

const ANSWERS = ['dworznik/todo', 'todo']

describe('addProject', () => {
  it('clones, Onboards, builds, and confirms the Harness can resolve it', async () => {
    const { result, ran, failure } = await run(ANSWERS, { before: [] })
    expect(failure).toBeUndefined()
    expect(result).toEqual({ name: 'todo', visible: true, imageBuilt: true })

    const stdins = ran.map((step) => step.stdin).join('\n')
    expect(stdins).toContain('clone')
    expect(stdins).toContain('sandcastle init')
    expect(stdins).toContain('build-image')
  })

  // Everything runs in the container, so every step is `compose exec` — a step
  // that ran on the Target's own shell instead would be one that needed the
  // token put somewhere for it to read.
  it('runs every step inside the Harness container', async () => {
    const { ran } = await run(ANSWERS, { before: [] })
    const withScript = ran.filter((step) => step.stdin !== '')
    expect(withScript.length).toBeGreaterThan(0)
    for (const step of withScript) {
      expect(step.script).toContain('docker compose exec -T harness bash -s')
    }
  })

  // Scaffolding over someone's customisations is not recoverable by re-running
  // anything, so it stops before the first change rather than failing partway.
  it('stops without touching an already-Onboarded Project', async () => {
    const { result, ran, shown } = await run(ANSWERS, {
      before: [{ name: 'todo', imageName: 'sandcastle:todo', onboarded: true }],
    })
    expect(result).toBeUndefined()
    expect(shown).toContain('already Onboarded')
    expect(ran.every((step) => !step.stdin.includes('sandcastle init'))).toBe(true)
    expect(ran.every((step) => !step.stdin.includes('clone'))).toBe(true)
  })

  // A checkout the operator already put there is a normal case — cloning over
  // it would fail, and refusing would make them move it for no reason.
  it('Onboards a checkout that is already there without cloning it', async () => {
    const { result, ran } = await run(ANSWERS, {
      before: [{ name: 'todo', imageName: 'sandcastle:todo', onboarded: false }],
    })
    expect(result?.visible).toBe(true)
    expect(ran.every((step) => !step.stdin.includes('clone'))).toBe(true)
    expect(ran.some((step) => step.stdin.includes('sandcastle init'))).toBe(true)
  })

  // The Harness's answer is the one that counts: a checkout can be on the
  // Target's disk and still be invisible to the Harness if the path-parity
  // mount or WORKSPACE_ROOT disagree, which is the failure this catches.
  it('reports that the Harness cannot resolve it, rather than claiming success', async () => {
    const { result, shown } = await run(ANSWERS, { before: [], after: [] })
    expect(result?.visible).toBe(false)
    expect(shown).toContain('cannot resolve')
  })

  // The Onboarding has landed by the time the build runs, so `sandcastle init`
  // would refuse a second attempt — "add it again" is the one thing that does
  // not work, and the message has to say what does.
  it('names the retry for a failed image build, which is not adding it again', async () => {
    const { result, shown } = await run(ANSWERS, { before: [], buildCode: 1 })
    expect(shown).toContain('do not add it again')
    expect(shown).toContain('build-image')
    // Still reports what the Harness sees: a Project with no image is a Run
    // that builds it, not a Project that is broken.
    expect(result?.name).toBe('todo')
  })

  // The menu reads this: an Onboarded Project with no image is not the same
  // as a finished one, and saying nothing would call it done. It is not a
  // throw, because a Run builds a missing image itself.
  it('reports a failed image build in its result, rather than swallowing it', async () => {
    const { result } = await run(ANSWERS, { before: [], buildCode: 1 })
    expect(result?.imageBuilt).toBe(false)
    expect(result?.visible).toBe(true)
  })

  // Cloning proves read access, and for a public repo it proves nothing at all.
  // Onboarding a repo the token cannot push to produces a Project every Run
  // gets most of the way through and then fails at the end of.
  it('stops before cloning when the token cannot push', async () => {
    const { result, ran, shown, asked } = await run(ANSWERS, { before: [], push: 'false' })
    expect(result).toBeUndefined()
    expect(shown).toContain('cannot push to dworznik/todo')
    expect(asked).toContain('  Onboard it anyway?')
    // Nothing was cloned, scaffolded or built.
    expect(ran.every((step) => !step.stdin.includes('clone'))).toBe(true)
    expect(ran.every((step) => !step.stdin.includes('sandcastle init'))).toBe(true)
  })

  it('goes ahead when told to, since the operator may be about to fix the token', async () => {
    const { result, ran } = await run(ANSWERS, {
      before: [],
      push: 'false',
      confirmAnyway: true,
    })
    expect(result?.visible).toBe(true)
    expect(ran.some((step) => step.stdin.includes('clone'))).toBe(true)
  })

  // A repo hosted elsewhere, or an unreachable API, must not block Onboarding
  // over a question that could not be asked.
  it('continues when the check could not be answered', async () => {
    const { result, shown } = await run(ANSWERS, { before: [], push: 'unknown' })
    expect(result?.visible).toBe(true)
    expect(shown).toContain('Could not check')
  })

  it('never carries a credential of its own', async () => {
    const { ran } = await run(ANSWERS, { before: [] })
    const everything = ran.map((step) => `${step.script}\n${step.stdin}`).join('\n')
    expect(everything).not.toMatch(/gh[ps]_|github_pat_|sk-ant-/u)
  })
})
