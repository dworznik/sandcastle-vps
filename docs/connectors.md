# Connectors

A **Connector** is how the creator CLI reaches a **Target**. It is the only
thing that differs between kinds of Target, and the wizard above it knows
nothing else about where a Target is — adding a kind is writing one of these
and registering it, with no change to the wizard.

The interface is `src/cli/connectors/types.ts`; the ssh implementation is
`src/cli/connectors/ssh.ts`. Three kinds are filed but not built: OrbStack
(#27), Docker Desktop (#28), and a remote engine over a docker context (#29).

## Adding one

Write the module, export a `ConnectorDefinition` beside its `Connector`, and
replace the kind's placeholder entry in `CONNECTORS` (`connectors/index.ts`).
Nothing above that line changes: the wizard reads the label, the address
question and the factory from the registry, and never names a kind itself. The
placeholder entries are what make an unbuilt kind fail with its issue number
instead of a type error.

A definition carries what the wizard needs to _ask_ about a Target — the label
in the "How is it reached?" list, and what its address is called (an ssh
destination, a machine name, nothing at all for a Target that is this machine).
There is no display field on `Connector` itself: a Target is described from its
profile, because "op@vps" is not a universal shape.

## The contract

```ts
interface Connector {
  readonly kind: 'ssh' | 'orb' | 'docker-desktop' | 'docker-context'
  exec(script: string, opts?: { stdin?: string | Readable; sudo?: boolean }): Promise<ExecResult>
  putTar(stream: Readable, destDir: string): Promise<void>
  preflight(): Promise<Preflight>
}
```

**A Target is not necessarily remote.** Docker Desktop's Target is the
operator's own machine. Nothing in the wizard may assume a network hop, a
second filesystem, or that a path on the Target is not also a path here.

**`exec` runs a shell script and never throws for a non-zero exit.** The exit
code is a result, not an error: preflight expects failures. Throw only when the
Target could not be reached at all. The script must be run by `bash` — a
Target's login shell may be zsh or fish, and neither will run a script written
for `sh`. Use `shellQuote` (`src/cli/shell.ts`) for anything interpolated into
one: the form it produces is read identically by sh, bash, zsh and fish.

**`exec({ sudo: true })` must never wait for a password.** A Connector has no
terminal to answer a prompt on, so a prompt is a hang. Use the non-interactive
form of whatever elevation the Target has (`sudo -n` for ssh) and rely on
`preflight().canElevate`, which the wizard checks before it offers to run
anything privileged.

**`exec({ stdin })` must leave the Target's own terminal alone.** ssh reads a
passphrase from `/dev/tty` rather than stdin, which is what lets an interactive
login coexist with a payload on stdin. A Connector that multiplexes them is
broken.

**`putTar` extracts a gzipped tar, stripping one leading path component.** The
stream is an `npm pack` tarball, whose entries are all under `package/`. Create
the destination if it is missing. Do not require rsync — on either end.

**`preflight` reports, it does not fix.** Return every check, passing and
failing, with a `remedy` for the ones a command can fix — and only when the
command would really work. A check that can fail for several reasons has to
tell them apart first: a Docker socket that will not open is a group membership
on one Target and a stopped daemon on another, and a `usermod` printed for the
second is a command that cannot help. A remedy is stored
_without_ `sudo`: the same string is printed for the operator (prefixed) and
handed to `exec({ sudo: true })`, so the two can never disagree. Probe in one
round trip — a check per round trip is a handshake per check on ssh Targets.
`src/cli/preflight.ts` holds the probe script and the pure evaluation, so a new
Connector reuses both and only supplies `exec`.

## Package delivery

The package _is_ the Harness (ADR 0006): the CLI ships its own contents, so a
Target needs neither git nor npm credentials and always runs the version the
operator invoked. `packSelf` (`src/cli/package.ts`) runs `npm pack`, which
applies exactly the rules `npm publish` would — the `files` list in
`package.json` is the single source of truth for what a Target receives.

**One thing `npm pack` will not ship: a root lockfile.** npm excludes
`pnpm-lock.yaml`, `package-lock.json` and `yarn.lock` unconditionally, whatever
`files` says. A Target therefore installs the Harness's dependencies from the
manifest's ranges, exactly as any consumer of a published package does, and the
Harness image build must not require a lockfile. Delivery from a checkout is
the same code path and gets the same result, so there is no shape that is only
ever exercised on a developer's machine.

## What the install asks of a Connector

Install/upgrade (`src/cli/install.ts`) is written against `exec` and `putTar`
and nothing else, which is what makes the three deferred connectors a matter of
writing a module rather than touching the wizard. Two obligations become
load-bearing there:

**`exec({ stdin })` carries the Target's environment file.** It holds the
agent's credentials, so it is never interpolated into a script — a script is an
argument list other processes on the Target can read. A Connector that cannot
stream stdin to a command cannot install.

**Everything the install needs of the Target is read off the Target.** The
operator's uid and gid, the docker group's gid, and the Inngest keys — which
are generated there, because a secret generated on the operator's machine is a
secret that travelled. Nothing is guessed from the machine the CLI runs on,
which is also what keeps a Target that _is_ that machine from being a special
case.

The verification afterwards (`src/cli/verify.ts`) leans on the same two and
adds no requirement of its own: it reads `/proc/net/tcp` with `cat` rather than
asking for iproute2, and runs both of its HTTP probes inside the Harness
container, whose image ships curl. A Target is never expected to have an HTTP
client — preflight asks for Docker, and the install may ask for nothing more.
