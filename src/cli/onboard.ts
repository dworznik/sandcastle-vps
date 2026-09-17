import type { Connector } from './connectors/types.js'
import { composeScript, fail, harnessPort, readEnvScript } from './install.js'
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
 * Turn what the operator typed into a clone URL.
 *
 * HTTPS on the way out whatever came in, including an ssh remote: the Sandbox
 * pushes with the PAT through a credential helper, and an ssh remote inside a
 * Sandbox would need a deploy key this platform does not issue (ADR 0006).
 */
export const repoUrl = (input: string): string => {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('No repository given.')
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/u.exec(trimmed)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`
  if (/^https?:\/\//u.test(trimmed)) return trimmed
  if (/^[\w.-]+\/[\w.-]+$/u.test(trimmed)) return `https://github.com/${trimmed}.git`
  throw new Error(
    `Not a repository this recognises: ${trimmed}\n` +
      'Give it as owner/name, or as a full https:// URL.',
  )
}

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
  if (!/^[\w.-]+$/u.test(name) || name === '.' || name === '..') {
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
  printf 'state\\texists\\n'
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

/** Same `key<TAB>value` wire as preflight and the install's facts probe. */
const readAnswer = (stdout: string): Record<string, string> => {
  const answer: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0) answer[line.slice(0, tab)] = line.slice(tab + 1)
  }
  return answer
}

/** Run one step in the Harness container and read its answer, raising whatever
 *  the step reported as wrong. */
const step = async (
  connector: Connector,
  installDir: string,
  script: string,
  what: string,
): Promise<Record<string, string>> => {
  const { code, stdout, stderr } = await connector.exec(inHarness(installDir), { stdin: script })
  const answer = readAnswer(stdout)
  if (answer.error) throw new Error(answer.error)
  if (code !== 0) throw fail(what, code, stderr || stdout)
  return answer
}

export interface OnboardResult {
  readonly name: string
  /** Whether the Harness can now resolve it — the only answer that matters,
   *  because it is the one a Dispatch will get. */
  readonly visible: boolean
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
  const built = await connector.exec(composeScript(profile.installDir, 'exec -T harness bash -s'), {
    stdin: buildScript(name),
  })
  if (built.code !== 0) {
    // Everything above this has landed: `sandcastle init` would now refuse, so
    // re-running "add a Project" is not the retry. Say what is.
    log(`\n  The image build failed (exit ${built.code}):`)
    log(`  ${built.stderr.trim().split('\n').at(-1) ?? built.stdout.trim().split('\n').at(-1)}`)
    log(`\n${name} is otherwise Onboarded — do not add it again. Fix its`)
    log('.sandcastle/Dockerfile and retry just the build:')
    log(
      `  ${composeScript(profile.installDir, `exec harness bash -lc 'cd "$WORKSPACE_ROOT"/${name} && ${SANDCASTLE} docker build-image'`)}`,
    )
    log('\nA Run against this Project would also build the image itself if it is missing.')
  }

  // The Harness's own answer, over the surface a Dispatch uses — this is what
  // proves the path-parity mount and WORKSPACE_ROOT line up, which nothing
  // visible on the Target's disk can.
  log('\nAsking the Harness what it can see…')
  const after = await connector.exec(projectsScript(profile.installDir, port))
  const visible = parseProjects(after.stdout.trim() || after.stderr.trim()).find(
    (project) => project.name === name && project.onboarded,
  )
  log(
    visible
      ? `  ${name} resolves, and its image is ${visible.imageName}.`
      : `  The Harness cannot resolve ${name}. Its log will say why.`,
  )

  return { name, visible: visible !== undefined }
}
