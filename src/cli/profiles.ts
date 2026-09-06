import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ConnectorKind } from "./connectors/types.js";

/**
 * A Target profile: where a Target is and what it is called. It lives on the
 * operator's machine and is **never a secret** — credentials are captured,
 * sent over the Connector, and forgotten (ADR 0006).
 *
 * The schema below is strict, so there is nowhere in a profile to put a secret
 * even by accident. That is the enforcement; the sentence above is only the
 * reason for it.
 */
const storedProfile = z.strictObject({
  connector: z.enum(["ssh", "orb", "docker-desktop", "docker-context"]),
  /** How the Connector addresses the Target — for ssh, any destination the
   *  operator's ssh already understands, including a config alias. */
  host: z.string().min(1),
  /** Absolute, both of them: they are handed to a shell on the Target, where
   *  `~` inside a quoted script does not expand. The wizard resolves them
   *  against the Target's own home when it creates the profile. */
  installDir: z.string().startsWith("/"),
  workspaceRoot: z.string().startsWith("/"),
});

export interface TargetProfile extends z.infer<typeof storedProfile> {
  /** The profile's file name, which is its identity. Not stored inside it. */
  readonly name: string;
  readonly connector: ConnectorKind;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export const validateTargetName = (name: string): string => {
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid Target name: "${name}". Use lowercase letters, digits and dashes — it is a file name.`,
    );
  }
  return name;
};

export const targetsDir = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sandcastle-vps", "targets");

export const targetPath = (name: string): string =>
  join(targetsDir(), `${validateTargetName(name)}.json`);

export const listTargets = async (): Promise<string[]> => {
  let entries: string[];
  try {
    entries = await readdir(targetsDir());
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((name) => NAME.test(name))
    .sort();
};

export const readTarget = async (name: string): Promise<TargetProfile> => {
  const path = targetPath(name);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`No Target called "${name}". Its profile would be at ${path}.`);
  }
  const parsed = storedProfile.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${path} is not a Target profile: ${z.prettifyError(parsed.error)}`);
  }
  return { name, ...parsed.data };
};

export const writeTarget = async ({ name, ...fields }: TargetProfile): Promise<void> => {
  const path = targetPath(name);
  const parsed = storedProfile.safeParse(fields);
  if (!parsed.success) {
    throw new Error(`Refusing to write ${path}: ${z.prettifyError(parsed.error)}`);
  }
  await mkdir(targetsDir(), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
};
