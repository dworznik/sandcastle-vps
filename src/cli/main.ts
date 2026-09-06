import { createReadStream } from "node:fs";
import { HELP, parseArgs } from "./args.js";
import { connectorFor } from "./connectors/index.js";
import type { Connector, Preflight } from "./connectors/types.js";
import { packSelf, packageVersion } from "./package.js";
import { formatPreflight, remedyCommand } from "./preflight.js";
import { createPrompter, type Prompter } from "./prompt.js";
import { listTargets, readTarget, targetsDir, validateTargetName, writeTarget, type TargetProfile } from "./profiles.js";

/** What is filed but not built, so a menu entry can say so precisely. */
const notBuiltYet = (what: string, issue: number): string =>
  `${what} is not built yet — see issue #${issue}.`;

/**
 * Create a Target profile. The Target is asked for its own home directory
 * rather than `~` being written into the profile: the paths in a profile are
 * handed to a shell inside a quoted script on the far side, where `~` is just
 * a character.
 */
const createTarget = async (prompter: Prompter): Promise<TargetProfile> => {
  const name = validateTargetName(await prompter.text("A short name for this Target", "vps"));
  const connectorKind = await prompter.select("How is it reached?", [
    { label: "ssh — a machine you can ssh into", value: "ssh" as const },
    {
      label: "the other Connectors (OrbStack, Docker Desktop, docker context) — not built yet",
      value: "deferred" as const,
    },
  ]);
  if (connectorKind === "deferred") {
    throw new Error(
      "Only the ssh Connector exists so far. The others are filed as #27, #28 and #29.",
    );
  }

  const host = await prompter.text("ssh destination (anything your ssh understands, e.g. op@vps)");

  // installDir is only read by preflight, which has not run yet — any value
  // does for the one command below.
  const { code, stdout, stderr } = await connectorFor({
    name,
    connector: "ssh",
    host,
    installDir: "/",
    workspaceRoot: "/",
  }).exec('printf "%s" "$HOME"');
  if (code !== 0 || !stdout.startsWith("/")) {
    throw new Error(`Could not reach ${host}: ${stderr.trim() || `ssh exited ${code}`}`);
  }
  const home = stdout.trim();

  const profile: TargetProfile = {
    name,
    connector: "ssh",
    host,
    installDir: await prompter.text("Where should the stack be installed?", `${home}/.sandcastle-vps`),
    workspaceRoot: await prompter.text("Where do the Project checkouts live?", `${home}/work`),
  };
  await writeTarget(profile);
  console.log(`\nSaved ${targetsDir()}/${name}.json — it holds no secrets, and never will.`);
  return profile;
};

const chooseTarget = async (prompter: Prompter, wanted?: string): Promise<TargetProfile> => {
  if (wanted) return readTarget(wanted);
  const names = await listTargets();
  if (names.length === 0) {
    console.log("No Targets yet. Let's describe one.");
    return createTarget(prompter);
  }
  const choice = await prompter.select("Which Target?", [
    ...names.map((name) => ({ label: name, value: name })),
    { label: "a new one…", value: null },
  ]);
  return choice === null ? createTarget(prompter) : readTarget(choice);
};

/** Run the checks and show them; offer to fix what can be fixed from here. */
const checkTarget = async (connector: Connector, prompter: Prompter): Promise<Preflight> => {
  console.log(`\nChecking the Target (${connector.description})…`);
  let preflight = await connector.preflight();
  console.log(formatPreflight(preflight));
  if (preflight.ok) return preflight;

  const fixable = preflight.checks.filter((check) => !check.ok && check.remedy);
  if (fixable.length === 0) return preflight;
  if (!preflight.canElevate) {
    console.log("\nRun the commands above on the Target yourself — elevation here needs a password.");
    return preflight;
  }
  if (!(await prompter.confirm(`\nRun ${fixable.length === 1 ? "that" : "those"} on the Target now?`))) {
    return preflight;
  }

  for (const check of fixable) {
    console.log(`\n  ${remedyCommand(check)}`);
    const { code, stderr } = await connector.exec(check.remedy as string, { sudo: true });
    if (code !== 0) {
      console.log(`  failed (exit ${code}): ${stderr.trim().split("\n").at(-1) ?? ""}`);
    }
  }

  console.log("\nRe-checking…");
  preflight = await connector.preflight();
  console.log(formatPreflight(preflight));
  return preflight;
};

/**
 * The package is what gets installed, so delivery is the CLI shipping its own
 * contents (ADR 0006). Bringing the stack up on top of them is #34.
 */
const installUpgrade = async (
  profile: TargetProfile,
  connector: Connector,
  prompter: Prompter,
): Promise<void> => {
  const preflight = await checkTarget(connector, prompter);
  if (!preflight.ok) {
    console.log("\nThe Target is not ready. Nothing was delivered.");
    return;
  }

  const version = await packageVersion();
  console.log(`\nDelivering @dworznik/sandcastle-vps ${version} to ${profile.host}:${profile.installDir}…`);
  const { tarball, cleanup } = await packSelf();
  try {
    await connector.putTar(createReadStream(tarball), profile.installDir);
  } finally {
    await cleanup();
  }
  console.log("Delivered.");
  console.log(`\n${notBuiltYet("Building the Harness image and starting the stack", 34)}`);
};

const menu = async (
  profile: TargetProfile,
  connector: Connector,
  prompter: Prompter,
): Promise<void> => {
  for (;;) {
    const action = await prompter.select(`Target ${profile.name} (${connector.description})`, [
      { label: "Install / upgrade", value: "install" as const },
      { label: "Add a Project", value: "project" as const },
      { label: "Rotate credentials", value: "rotate" as const },
      { label: "Status", value: "status" as const },
      { label: "Quit", value: "quit" as const },
    ]);
    if (action === "quit") return;
    if (action === "install") await installUpgrade(profile, connector, prompter);
    if (action === "project") console.log(`\n${notBuiltYet("Adding a Project", 36)}`);
    if (action === "rotate") console.log(`\n${notBuiltYet("Rotating credentials", 37)}`);
    if (action === "status") console.log(`\n${notBuiltYet("Status", 37)}`);
  }
};

export const runCli = async (argv: readonly string[]): Promise<number> => {
  let prompter: Prompter | undefined;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(HELP);
      return 0;
    }
    console.log(`sandcastle-vps ${await packageVersion()}`);
    prompter = createPrompter();
    const profile = await chooseTarget(prompter, args.target);
    await menu(profile, connectorFor(profile), prompter);
    return 0;
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    prompter?.close();
  }
};
