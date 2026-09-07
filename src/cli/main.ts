import { createReadStream } from "node:fs";
import { HELP, parseArgs } from "./args.js";
import { CONNECTORS, connectorFor } from "./connectors/index.js";
import type { Connector, Preflight, PreflightCheck } from "./connectors/types.js";
import { packSelf, packageVersion } from "./package.js";
import { formatPreflight, remedyCommand } from "./preflight.js";
import { createPrompter, type Prompter } from "./prompt.js";
import {
  describeTarget,
  listTargets,
  readTarget,
  targetsDir,
  validateTargetName,
  writeTarget,
  type TargetProfile,
} from "./profiles.js";

/** What is filed but not built, so a menu entry can say so precisely. */
const notBuiltYet = (what: string, issue: number): string =>
  `${what} is not built yet — see issue #${issue}.`;

/** One Target, the way to reach it, and the operator answering questions.
 *  These three travel everywhere together. */
interface Session {
  readonly profile: TargetProfile;
  readonly connector: Connector;
  readonly prompter: Prompter;
}

/** A failing check the wizard can actually offer to fix. */
type Fixable = PreflightCheck & { readonly remedy: string };
const isFixable = (check: PreflightCheck): check is Fixable => !check.ok && check.remedy !== undefined;

/**
 * Create a Target profile. The Target is asked for its own home directory
 * rather than `~` being written into the profile: the paths in a profile are
 * handed to a shell inside a quoted script on the far side, where `~` is just
 * a character.
 */
const createTarget = async (prompter: Prompter): Promise<TargetProfile> => {
  const name = validateTargetName(await prompter.text("A short name for this Target", "vps"));
  const definition = await prompter.select(
    "How is it reached?",
    CONNECTORS.map((candidate) => ({ label: candidate.label, value: candidate })),
  );
  if (definition.issue !== undefined) {
    throw new Error(`${definition.label.split(" — ")[0]} is not built yet — see issue #${definition.issue}.`);
  }

  const host = await prompter.text(definition.addressLabel);

  // installDir and workspaceRoot are only read once the Target is being worked
  // on, and the one command below reads neither — any value does for it.
  const { code, stdout, stderr } = await definition
    .create({ host, installDir: "/", workspaceRoot: "/" })
    .exec('printf "%s" "$HOME"');
  if (code !== 0 || !stdout.startsWith("/")) {
    throw new Error(`Could not reach the Target: ${stderr.trim() || `the check exited ${code}`}`);
  }
  const home = stdout.trim();

  const profile: TargetProfile = {
    name,
    connector: definition.kind,
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
const checkTarget = async ({ profile, connector, prompter }: Session): Promise<Preflight> => {
  console.log(`\nChecking the Target (${describeTarget(profile)})…`);
  let preflight = await connector.preflight();
  console.log(formatPreflight(preflight));
  if (preflight.ok) return preflight;

  const fixable = preflight.checks.filter(isFixable);
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
    const { code, stderr } = await connector.exec(check.remedy, { sudo: true });
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
const installUpgrade = async (session: Session): Promise<void> => {
  const { profile, connector } = session;
  const preflight = await checkTarget(session);
  if (!preflight.ok) {
    console.log("\nThe Target is not ready. Nothing was delivered.");
    return;
  }

  const version = await packageVersion();
  console.log(
    `\nDelivering @dworznik/sandcastle-vps ${version} to ${describeTarget(profile)} → ${profile.installDir}…`,
  );
  const { tarball, cleanup } = await packSelf();
  try {
    await connector.putTar(createReadStream(tarball), profile.installDir);
  } finally {
    await cleanup();
  }
  console.log("Delivered.");
  console.log(`\n${notBuiltYet("Building the Harness image and starting the stack", 34)}`);
};

const menu = async (session: Session): Promise<void> => {
  const { profile, prompter } = session;
  for (;;) {
    const action = await prompter.select(`Target ${profile.name} (${describeTarget(profile)})`, [
      { label: "Install / upgrade", value: "install" as const },
      { label: "Add a Project", value: "project" as const },
      { label: "Rotate credentials", value: "rotate" as const },
      { label: "Status", value: "status" as const },
      { label: "Quit", value: "quit" as const },
    ]);
    if (action === "quit") return;
    if (action === "install") await installUpgrade(session);
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
    await menu({ profile, connector: connectorFor(profile), prompter });
    return 0;
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    prompter?.close();
  }
};
