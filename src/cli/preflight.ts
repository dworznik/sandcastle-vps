import { shellQuote } from "./shell.js";
import type { Preflight, PreflightCheck } from "./connectors/types.js";

/**
 * Room for the Harness image, one Project's Sandbox image (a Node base with
 * Claude Code and the skill set baked in), and the worktrees Runs leave behind.
 * A Target under this will get through an install and fail on the first Run.
 */
const MIN_FREE_KIB = 10 * 1024 * 1024;

/** What the published images are built for. */
const SUPPORTED_ARCHITECTURES = ["x86_64", "amd64", "aarch64", "arm64"];

/**
 * One shell script, run once through the Connector: a round trip per check
 * would be a round trip per check on every Target kind, and the ssh ones cost
 * a handshake each. Every line is `key<TAB>value`; a check the Target cannot
 * answer prints nothing at all, and is read as a failure rather than a pass.
 */
export const probeScript = (installDir: string): string => `set -u
printf 'user\\t%s\\n' "$(id -un)"
printf 'arch\\t%s\\n' "$(uname -m)"
if command -v docker > /dev/null 2>&1; then
  printf 'docker\\t%s\\n' "$(docker --version 2>/dev/null | head -1)"
fi
if docker compose version > /dev/null 2>&1; then
  printf 'compose\\t%s\\n' "$(docker compose version --short 2>/dev/null | head -1)"
fi
if docker info > /dev/null 2>&1; then
  printf 'docker-group\\tyes\\n'
else
  printf 'docker-group\\tno\\n'
fi
# The install directory may not exist yet, so measure the nearest ancestor that
# does — that is the filesystem it will land on.
dir=${shellQuote(installDir)}
while [ ! -d "$dir" ] && [ "$dir" != "/" ]; do dir="$(dirname "$dir")"; done
printf 'disk\\t%s\\n' "$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
if sudo -n true > /dev/null 2>&1; then
  printf 'sudo\\tyes\\n'
else
  printf 'sudo\\tno\\n'
fi`;

export const parseProbe = (stdout: string): Record<string, string> => {
  const probe: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    probe[line.slice(0, tab)] = line.slice(tab + 1);
  }
  return probe;
};

const gibibytes = (kib: number): string => `${(kib / 1024 / 1024).toFixed(1)} GiB`;

export const evaluateProbe = (probe: Record<string, string>): Preflight => {
  const user = probe.user ?? "the operator";
  const freeKib = Number(probe.disk);
  const arch = probe.arch ?? "";

  const checks: PreflightCheck[] = [
    probe.docker
      ? { id: "docker", ok: true, detail: probe.docker }
      : {
          id: "docker",
          ok: false,
          detail: "not installed",
          remedy: "sh -c 'curl -fsSL https://get.docker.com | sh'",
          needsSudo: true,
          note: "Or follow https://docs.docker.com/engine/install/ for this distribution.",
        },
    probe.compose
      ? { id: "compose", ok: true, detail: `compose plugin ${probe.compose}` }
      : {
          id: "compose",
          ok: false,
          detail: "the compose plugin is missing",
          remedy: "apt-get install -y docker-compose-plugin",
          needsSudo: true,
          note: "Debian and Ubuntu; elsewhere install your distribution's docker-compose-plugin.",
        },
    probe["docker-group"] === "yes"
      ? { id: "docker-group", ok: true, detail: `${user} can use the Docker socket` }
      : {
          id: "docker-group",
          ok: false,
          detail: `${user} cannot use the Docker socket`,
          remedy: `usermod -aG docker ${user}`,
          needsSudo: true,
          note: "Group membership only applies to new sessions — reconnect afterwards.",
        },
    Number.isFinite(freeKib) && freeKib >= MIN_FREE_KIB
      ? { id: "disk", ok: true, detail: `${gibibytes(freeKib)} free` }
      : {
          id: "disk",
          ok: false,
          detail: Number.isFinite(freeKib)
            ? `${gibibytes(freeKib)} free, and the images need ${gibibytes(MIN_FREE_KIB)}`
            : "free space not reported",
        },
    SUPPORTED_ARCHITECTURES.includes(arch)
      ? { id: "arch", ok: true, detail: arch }
      : {
          id: "arch",
          ok: false,
          detail: arch
            ? `${arch}, and the images are built for ${SUPPORTED_ARCHITECTURES.join(", ")}`
            : "architecture not reported",
        },
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
    canElevate: probe.sudo === "yes",
    user,
  };
};

/** The remedy as a human would have to type it. */
export const remedyCommand = (check: PreflightCheck): string | undefined =>
  check.remedy === undefined ? undefined : check.needsSudo ? `sudo ${check.remedy}` : check.remedy;

export const formatPreflight = (preflight: Preflight): string => {
  const lines = preflight.checks.map((check) => `  ${check.ok ? "ok  " : "FAIL"}  ${check.id.padEnd(13)}${check.detail}`);
  for (const check of preflight.checks.filter((check) => !check.ok)) {
    const command = remedyCommand(check);
    if (command) lines.push("", `  Fix ${check.id}:`, `    ${command}`);
    else if (check.note) lines.push("", `  ${check.id}: ${check.note}`);
    if (command && check.note) lines.push(`    ${check.note}`);
  }
  return lines.join("\n");
};
