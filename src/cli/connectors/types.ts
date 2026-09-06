import type { Readable } from "node:stream";

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
  readonly kind: ConnectorKind;
  /** How this Target is addressed, for display only (e.g. `ssh: op@vps`). */
  readonly description: string;
  /**
   * Run a shell script on the Target and collect its output. Never throws for
   * a non-zero exit — the caller decides what a failure means.
   */
  exec(script: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Extract a gzipped tar onto the Target, stripping its single root entry. */
  putTar(stream: Readable, destDir: string): Promise<void>;
  /** Report whether this Target can host the stack. */
  preflight(): Promise<Preflight>;
}

export type ConnectorKind = "ssh" | "orb" | "docker-desktop" | "docker-context";

export interface ExecOptions {
  /** Fed to the script's stdin. */
  readonly stdin?: string | Readable;
  /** Run the script as root. Only ever used after preflight reports
   *  `canElevate` — elevation that would prompt for a password has nowhere to
   *  read one from. */
  readonly sudo?: boolean;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What preflight looks at. One id per thing that can be separately wrong. */
export type CheckId = "docker" | "compose" | "docker-group" | "disk" | "arch";

export interface PreflightCheck {
  readonly id: CheckId;
  readonly ok: boolean;
  /** What the Target reported, for the operator to read. */
  readonly detail: string;
  /** The command that fixes it, without any `sudo` prefix: the same string is
   *  printed for the operator (prefixed) and handed to `exec` (with
   *  `sudo: true`), so it can only ever exist in one form. */
  readonly remedy?: string;
  readonly needsSudo?: boolean;
  /** Anything the command alone doesn't say. */
  readonly note?: string;
}

export interface Preflight {
  /** True when every check passed. */
  readonly ok: boolean;
  readonly checks: readonly PreflightCheck[];
  /** Whether this Connector can run a remedy itself — that is, whether
   *  elevation on the Target needs no password. */
  readonly canElevate: boolean;
  /** The account on the Target that will own the stack. */
  readonly user: string;
}
