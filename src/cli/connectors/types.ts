import type { Readable } from 'node:stream'

/**
 * How the creator CLI reaches a Target. Everything the wizard does to a Target
 * goes through this interface — deliver the package, run a command, check the
 * ground — so adding a kind of Target is writing one of these and nothing else.
 *
 * A Target is not necessarily remote: the Docker Desktop connector's Target is
 * the operator's own machine. Nothing here may assume a network hop, a remote
 * shell, or a second filesystem.
 *
 * See docs/connectors.md for the contract each implementation owes its caller.
 */
export interface Connector {
  readonly kind: ConnectorKind
  /**
   * Run a shell script on the Target and collect its output. Never throws for
   * a non-zero exit — the caller decides what a failure means.
   */
  exec(script: string, opts?: ExecOptions): Promise<ExecResult>
  /** Extract a gzipped tar onto the Target, stripping its single root entry. */
  putTar(stream: Readable, destDir: string): Promise<void>
  /** Report whether this Target can host the stack. */
  preflight(): Promise<Preflight>
  /**
   * Run a script on the Target with the operator's terminal attached — a
   * TTY on both ends — and resolve with its exit code once it ends. This is
   * how a Session is attached to (ADR 0007), and it is a capability rather
   * than an obligation: a kind of Target with no terminal to offer leaves it
   * out, and the wizard says so instead of failing. `exec` stays
   * terminal-free either way — see docs/connectors.md.
   */
  attach?(script: string): Promise<number>
}

export type ConnectorKind = 'ssh' | 'orb' | 'docker-desktop' | 'docker-context'

/**
 * Everything the wizard needs to know about a kind of Target: what to call it,
 * what to ask for as its address, and how to build a Connector for it. The
 * wizard reads this and nothing else about kinds, which is what keeps adding
 * one to a single file plus a line in the registry.
 */
export interface ConnectorDefinition {
  readonly kind: ConnectorKind
  /** Shown when the operator is asked how a Target is reached. */
  readonly label: string
  /** What to ask for — an ssh destination, a machine name, nothing at all. */
  readonly addressLabel: string
  /** The issue that builds this kind, while it is still only filed. */
  readonly issue?: number
  readonly create: (target: TargetAddress) => Connector
}

/** The part of a Target profile a Connector needs to address it. */
export interface TargetAddress {
  readonly host: string
  readonly installDir: string
  readonly workspaceRoot: string
}

export interface ExecOptions {
  /** Written to the script's stdin, which is why a Connector must not use
   *  stdin for anything of its own — see docs/connectors.md. */
  readonly stdin?: string | Readable
  /** Run the script as root. Only ever used after preflight reports
   *  `canElevate` — elevation that would prompt for a password has nowhere to
   *  read one from. */
  readonly sudo?: boolean
}

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** What preflight looks at. One id per thing that can be separately wrong. */
export type CheckId = 'docker' | 'compose' | 'docker-group' | 'disk' | 'arch'

export interface PreflightCheck {
  readonly id: CheckId
  readonly ok: boolean
  /** What the Target reported, for the operator to read. */
  readonly detail: string
  /** The command that fixes it, without any `sudo` prefix: the same string is
   *  printed for the operator (prefixed) and handed to `exec` (with
   *  `sudo: true`), so it can only ever exist in one form. */
  readonly remedy?: string
  readonly needsSudo?: boolean
  /** Anything the command alone doesn't say. */
  readonly note?: string
}

export interface Preflight {
  readonly ok: boolean
  readonly checks: readonly PreflightCheck[]
  /** Whether this Connector can run a remedy itself — that is, whether
   *  elevation on the Target needs no password. */
  readonly canElevate: boolean
  /** The account on the Target that will own the stack. */
  readonly user: string
}
