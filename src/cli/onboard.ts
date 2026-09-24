import { repoSlug, repoUrl } from '../repo.js'
import type { Connector } from './connectors/types.js'
import { composeScript, fail, harnessPort, readEnvScript } from './install.js'
import { parseProbe } from './preflight.js'
import type { Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { shellQuote } from './shell.js'
import { onTargetLoopback } from './verify.js'

/**
 * Adding a Project: clone a repository into the workspace root, Onboard it,
 * build its image, and confirm the Harness can see it.
 *
 * Every step runs **inside the Harness container**, which is what makes this
 * possible at all. The container already holds the PAT in its environment, has
 * git and the sandcastle CLI, mounts the workspace root at path parity, and
 * runs as the operator who owns those checkouts. Doing the same work over a
 * plain shell on the Target would mean putting a token somewhere for that shell
 * to read, and installing a toolchain the Target is not otherwise asked for.
 *
 * The consequence worth stating: the token never leaves the Target, and this
 * CLI never handles it. Nothing here interpolates a credential, because there
 * is no credential here to interpolate — the scripts name `$GH_TOKEN`, and the
 * container resolves it.
 */

/** A repository, as the operator can be expected to name it. */
export const REPO_PROMPT = 'Repository (owner/name, or an https:// URL)'

/**
 * The directory the checkout lands in, which is also the Project's name and
 * the suffix of its image (ADR 0003). Derived from the repository rather than
 * asked for, then offered to the operator to change.
 */
export const projectNameFor = (input: string): string => {
  const last = repoUrl(input).replace(/\/+$/u, '').split('/').at(-1) ?? ''
  return last.replace(/\.git$/u, '')
}

/** The same rule `resolveProject` applies on the Harness side. A name that
 *  cannot be resolved there is a name that cannot be Onboarded here. */
export const validateProjectName = (name: string): string => {
  // No leading dash: `git clone <url> -foo` reads that as an option, whatever
  // the shell quoting around it did.
  if (!/^[\w.][\w.-]*$/u.test(name) || name === '.' || name === '..') {
    throw new Error(
      `Invalid Project name: ${name}\n` +
        'It is a directory under the workspace root, so it can only be a plain name.',
    )
  }
  return name
}

// ------------------------------------------------------- talking to the Target

/**
 * Run a script inside the Harness container, with the script arriving on
 * stdin.
 *
 * On stdin rather than as an argument, which keeps this to one level of
 * quoting instead of three — the Connector's own `bash -c`, the Target's, and
 * the container's. Nested quoting is how a Project name with a quote in it
 * would have become a command.
 */
export const inHarness = (installDir: string): string =>
  composeScript(installDir, 'exec -T harness bash -s')

/** Ask the Harness what it can see. Run on the Target's own loopback, through
 *  the published port, so the answer is the one a Dispatch would get. */
export const projectsScript = (installDir: string, port: number): string =>
  onTargetLoopback(installDir, `curl -sS -m 10 http://127.0.0.1:${port}/projects`)

/** The same question about one Project. Its answer comes from the same
 *  `resolveProject` a Dispatch calls, and a 404 carries the Harness's own
 *  reason — which is a better thing to print than "it was not in the list". */
export const projectScript = (installDir: string, port: number, name: string): string =>
  onTargetLoopback(
    installDir,
    `curl -sS -m 10 http://127.0.0.1:${port}/projects/${encodeURIComponent(name)}`,
  )

/**
 * Whether the Harness's token may *push* to this repository.
 *
 * Cloning proves read access and nothing more — and for a public repository it
 * proves nothing at all, because git needs no credential to read one. So a
 * repository outside the token's selected set Onboards cleanly and then fails
 * at the first `git push`, inside a Run, long after the cause. This asks the
 * question where a repository is finally named.
 *
 * `curl` rather than `gh`: the Harness image carries curl and not the GitHub
 * CLI. The token is named, never interpolated — same rule as the clone.
 */
export const pushAccessScript = (slug: string): string => `set -eu
if [ -z "\${GH_TOKEN:-}" ]; then
  printf 'error\\tThe Harness holds no GitHub token. Run install/upgrade first.\\n'
  exit 0
fi
body="$(curl -sS -H "Authorization: Bearer $GH_TOKEN" \\
  -H 'Accept: application/vnd.github+json' \\
  https://api.github.com/repos/${shellQuote(slug)} 2> /dev/null | tr -d ' \\n')"
case "$body" in
  *'"push":true'*) printf 'push\\ttrue\\n' ;;
  *'"push":false'*) printf 'push\\tfalse\\n' ;;
  *) printf 'push\\tunknown\\n' ;;
esac`

/** The command that retries only the image build, for an operator whose
 *  Project is Onboarded and whose Dockerfile needs a fix. */
export const buildRetryCommand = (installDir: string, name: string): string =>
  composeScript(
    installDir,
    `exec harness bash -lc ${shellQuote(`cd "$WORKSPACE_ROOT"/${name} && ${SANDCASTLE} docker build-image`)}`,
  )

export interface RemoteProject {
  readonly name: string
  readonly imageName: string
  readonly onboarded: boolean
}

/** Read the Harness's answer, or say what came back instead of one. A body
 *  that is not JSON came from docker or curl, not the Harness. */
export const parseProjects = (stdout: string): RemoteProject[] => {
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    throw new Error(
      `The Harness did not answer with a list of Projects. It said:\n${stdout.trim() || '(nothing)'}`,
    )
  }
  const projects = (body as { projects?: unknown })?.projects
  if (!Array.isArray(projects)) {
    throw new Error(`The Harness answered, but with no list of Projects in it:\n${stdout.trim()}`)
  }
  return projects as RemoteProject[]
}

/**
 * The Harness's answer about one Project: the resolved Project, or the reason
 * it could not resolve it. Both are answers, which is why neither throws — a
 * 404 here is the finding, not a failure of the question.
 */
export const parseProject = (stdout: string): RemoteProject | { readonly error: string } => {
  let body: unknown
  try {
    body = JSON.parse(stdout)
  } catch {
    return { error: stdout.trim().split('\n')[0] || 'it did not answer' }
  }
  const named = body as { imageName?: unknown; error?: unknown }
  if (typeof named?.imageName === 'string') return body as RemoteProject
  return { error: typeof named?.error === 'string' ? named.error : stdout.trim() }
}

/**
 * Clone the repository into the workspace root.
 *
 * The PAT reaches git through a one-shot credential helper and nowhere else:
 * `-c` config is command-line only, so it never lands in the checkout's
 * `.git/config`, and the helper reads `$GH_TOKEN` from the container's own
 * environment rather than being handed a value. The remote stays the plain
 * HTTPS URL, which is what lets a Sandbox push through `gh` with the same
 * token later.
 */
export const cloneScript = (url: string, name: string): string => `set -eu
cd "$WORKSPACE_ROOT"
if [ -e ${shellQuote(name)} ]; then
  # There already, but only a checkout can be Onboarded. Scaffolding
  # .sandcastle/ into a directory that is not a repository produces a Project
  # every Run then fails on, for a reason nothing here would have explained —
  # the retired init-project guarded this the same way.
  if [ -d ${shellQuote(name)}/.git ]; then
    printf 'state\\texists\\n'
  else
    printf 'error\\t%s is already there and is not a git checkout. Move it aside, or pick another name.\\n' ${shellQuote(name)}
  fi
  exit 0
fi
if [ -z "\${GH_TOKEN:-}" ]; then
  printf 'error\\tThe Harness holds no GitHub token, so it cannot clone. Run install/upgrade first.\\n'
  exit 0
fi
# No terminal in this container to answer a credential prompt on, so a repo the
# token cannot reach must fail rather than wait for one.
export GIT_TERMINAL_PROMPT=0
if git -c credential.helper= \\
       -c credential.helper='!f() { printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; }; f' \\
       clone --origin origin ${shellQuote(url)} ${shellQuote(name)} > /dev/null 2>&1; then
  printf 'state\\tcloned\\n'
else
  printf 'error\\tCould not clone %s. Check the repository exists and the token can read it.\\n' ${shellQuote(url)}
fi`

/** The sandcastle CLI, inside the Harness image. */
const SANDCASTLE = '/app/node_modules/.bin/sandcastle'

/** This stack's Sandbox extras, inside the Harness image. Copied in by
 *  `docker/harness/Dockerfile` for exactly this — Onboarding runs in the
 *  container, so the fragment has to be there rather than in the install
 *  directory. */
const EXTRAS = '/app/docker/sandbox/extras.Dockerfile'

/**
 * Scaffold the Project's sandcastle configuration, then append this stack's
 * extras to it.
 *
 * `sandcastle init` refuses when `.sandcastle/` already exists, and that
 * refusal is the guard against scaffolding over an operator's customisations —
 * so it is checked first, to say so plainly, and then left in place as the
 * thing that actually enforces it.
 *
 * No `.sandcastle/.env` is written. A Project carries no credentials (ADR
 * 0006), and a stale copy of a token the Harness already holds is worse than
 * none.
 *
 * `sandcastle init` ignores `logs/` and `worktrees/` under `.sandcastle/`; the
 * run directories a Run keeps beside them are this stack's, so this adds
 * `runs/` to the same file.
 */
export const onboardScript = (name: string): string => `set -eu
cd "$WORKSPACE_ROOT"/${shellQuote(name)}
if [ -e .sandcastle ]; then
  printf 'error\\t%s is already Onboarded — it has a .sandcastle directory. Delete it to start over.\\n' ${shellQuote(name)}
  exit 0
fi
${SANDCASTLE} init \\
  --agent claude-code \\
  --sandbox docker \\
  --template blank \\
  --issue-tracker github-issues \\
  --create-label false \\
  --build-image false \\
  --install-template-deps false > /dev/null
cat ${EXTRAS} >> .sandcastle/Dockerfile
printf 'runs/\\n' >> .sandcastle/.gitignore
printf 'state\\tonboarded\\n'`

/** Build the Project's own image, through the Target engine's socket. */
export const buildScript = (name: string): string =>
  `cd "$WORKSPACE_ROOT"/${shellQuote(name)} && ${SANDCASTLE} docker build-image`

// ------------------------------------------------------------------ the action

export interface OnboardSession {
  readonly profile: TargetProfile
  readonly connector: Connector
  readonly prompter: Prompter
}

type Log = (line: string) => void

/** Run one step in the Harness container and read its answer, raising whatever
 *  the step reported as wrong. */
const step = async (
  connector: Connector,
  installDir: string,
  script: string,
  what: string,
): Promise<Record<string, string>> => {
  const { code, stdout, stderr } = await connector.exec(inHarness(installDir), { stdin: script })
  const answer = parseProbe(stdout)
  if (answer.error) throw new Error(answer.error)
  if (code !== 0) throw fail(what, code, stderr || stdout)
  return answer
}

export interface OnboardResult {
  readonly name: string
  /** Whether the Harness can now resolve it — the answer that matters most,
   *  because it is the one a Dispatch will get. */
  readonly visible: boolean
  /** Whether its image built. Reported rather than thrown: the Project is
   *  Onboarded either way, and a Run builds a missing image itself — but a
   *  wizard that said nothing would be calling a half-finished Project done. */
  readonly imageBuilt: boolean
}

/**
 * The menu's "Add a Project": everything between a repository URL and a
 * checkout the Harness will accept a Dispatch for.
 */
export const addProject = async (
  session: OnboardSession,
  log: Log = console.log,
): Promise<OnboardResult | undefined> => {
  const { profile, connector, prompter } = session

  const env = await connector.exec(readEnvScript(profile.installDir))
  const port = harnessPort(env.stdout)

  log('\nAdd a Project')
  log('The repository is cloned into the workspace root and Onboarded inside the')
  log('Harness container, which already holds the token — so no credential is')
  log('handled here, and none is written into the checkout.')

  const url = repoUrl(await prompter.text(REPO_PROMPT))
  const name = validateProjectName(
    await prompter.text('Project name (the directory, and the image suffix)', projectNameFor(url)),
  )

  // Before anything is cloned or scaffolded, because the answer can be "do not
  // bother". A Project the token cannot push to is a Project every Run gets
  // most of the way through and then fails at the end of.
  const slug = repoSlug(url)
  if (slug) {
    const access = await step(
      connector,
      profile.installDir,
      pushAccessScript(slug),
      "Checking the token's access",
    )
    if (access.push === 'false') {
      log(`\n  The Harness's token cannot push to ${slug}.`)
      log('  A Run would clone, work and commit, then fail at push. A fine-grained')
      log('  token grants the same permissions across every repository it selects,')
      log(`  so this usually means ${slug} is not in that set — or is public and`)
      log('  outside it, which reads the same to a clone and differently to a push.')
      if (!(await prompter.confirm('  Onboard it anyway?'))) {
        log('\nNothing was changed.')
        return undefined
      }
    } else if (access.push !== 'true') {
      log(`\n  Could not check whether the token can push to ${slug}. Continuing.`)
    }
  }

  // Asked before anything is done, because "it is already Onboarded" is a
  // reason to stop rather than a step that fails halfway.
  const before = await connector.exec(projectsScript(profile.installDir, port))
  const existing = parseProjects(before.stdout.trim() || before.stderr.trim()).find(
    (project) => project.name === name,
  )
  if (existing?.onboarded) {
    log(`\n${name} is already Onboarded. Nothing was changed.`)
    log(`Its image is ${existing.imageName}; a Dispatch to it will resolve.`)
    return undefined
  }

  if (existing) {
    log(`\n${name} is already a checkout under the workspace root — Onboarding it in place.`)
  } else {
    log(`\nCloning ${url}…`)
    const cloned = await step(
      connector,
      profile.installDir,
      cloneScript(url, name),
      'Cloning the repository',
    )
    log(cloned.state === 'exists' ? '  It was already there.' : '  Cloned.')
  }

  log('\nScaffolding .sandcastle/ and appending this stack’s extras…')
  await step(connector, profile.installDir, onboardScript(name), 'Onboarding the Project')

  log('\nBuilding the Project’s image. This is the slow part — it bakes in the agent')
  log('and the skill set, and it only happens once per Project.')
  // Not through `step`, deliberately: a failed build is the one step here that
  // must not throw. The Onboarding above it has landed, and the operator needs
  // the retry printed rather than a stack unwound past it.
  const built = await connector.exec(inHarness(profile.installDir), { stdin: buildScript(name) })
  if (built.code !== 0) {
    // `sandcastle init` would now refuse, so re-running "add a Project" is not
    // the retry. Say what is.
    log(`\n  The image build failed (exit ${built.code}):`)
    log(`  ${built.stderr.trim().split('\n').at(-1) ?? built.stdout.trim().split('\n').at(-1)}`)
    log(`\n${name} is otherwise Onboarded — do not add it again. Fix its`)
    log('.sandcastle/Dockerfile and retry just the build:')
    log(`  ${buildRetryCommand(profile.installDir, name)}`)
    log('\nA Run against this Project would also build the image itself if it is missing.')
  }

  // The Harness's own answer, over the surface a Dispatch uses — this is what
  // proves the path-parity mount and WORKSPACE_ROOT line up, which nothing
  // visible on the Target's disk can. Asked by name rather than by listing:
  // the route answers 404 carrying the Harness's own reason, which is a better
  // thing to print than "it was not in the list".
  log('\nAsking the Harness what it can see…')
  const after = await connector.exec(projectScript(profile.installDir, port, name))
  const resolved = parseProject(after.stdout.trim() || after.stderr.trim())
  log(
    'imageName' in resolved
      ? `  ${name} resolves, and its image is ${resolved.imageName}.`
      : `  The Harness cannot resolve ${name}: ${resolved.error}`,
  )

  return { name, visible: 'imageName' in resolved, imageBuilt: built.code === 0 }
}
