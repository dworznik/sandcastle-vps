import { describe, expect, it } from "vitest";
import { evaluateProbe, formatPreflight, parseProbe, probeScript } from "./preflight.js";

const goodProbe = [
  "user\top",
  "arch\tx86_64",
  "docker\tDocker version 29.3.0, build abc",
  "compose\t2.40.3",
  "docker-group\tyes",
  "disk\t52428800",
  "sudo\tyes",
].join("\n");

describe("parseProbe", () => {
  it("reads tab-separated keys and values", () => {
    expect(parseProbe("arch\tx86_64\nsudo\tno\n")).toEqual({ arch: "x86_64", sudo: "no" });
  });

  it("keeps a value that itself contains tabs", () => {
    expect(parseProbe("docker\tDocker\tversion 29")).toEqual({ docker: "Docker\tversion 29" });
  });

  it("ignores blank and malformed lines rather than inventing keys", () => {
    expect(parseProbe("\nnot-a-pair\narch\taarch64\n")).toEqual({ arch: "aarch64" });
  });
});

describe("evaluateProbe", () => {
  it("passes a Target that has everything", () => {
    const preflight = evaluateProbe(parseProbe(goodProbe));
    expect(preflight.ok).toBe(true);
    expect(preflight.user).toBe("op");
    expect(preflight.canElevate).toBe(true);
    expect(preflight.checks.every((check) => check.ok)).toBe(true);
  });

  it("reports every check, so the operator sees the whole ground at once", () => {
    const ids = evaluateProbe(parseProbe(goodProbe)).checks.map((check) => check.id);
    expect(ids).toEqual(["docker", "compose", "docker-group", "disk", "arch"]);
  });

  it("fails when Docker is absent, and names the command that installs it", () => {
    const preflight = evaluateProbe(parseProbe("user\top\narch\tx86_64\ndisk\t52428800\n"));
    const docker = preflight.checks.find((check) => check.id === "docker");
    expect(preflight.ok).toBe(false);
    expect(docker?.ok).toBe(false);
    expect(docker?.remedy).toContain("get.docker.com");
    expect(docker?.needsSudo).toBe(true);
  });

  // The remedy is stored without it so the same string can be printed for a
  // human and handed to exec({ sudo: true }).
  it("keeps sudo out of the remedy itself", () => {
    for (const check of evaluateProbe(parseProbe("user\top\n")).checks) {
      expect(check.remedy ?? "").not.toContain("sudo");
    }
  });

  it("fails when the operator cannot use the socket, and names them in the fix", () => {
    const preflight = evaluateProbe(
      parseProbe(
        `${goodProbe.replace("docker-group\tyes", "docker-group\tno")}\ndocker-error\tdial unix /var/run/docker.sock: connect: permission denied`,
      ),
    );
    const group = preflight.checks.find((check) => check.id === "docker-group");
    expect(group?.ok).toBe(false);
    expect(group?.remedy).toBe("usermod -aG docker 'op'");
    // usermod alone doesn't take effect in the session that ran it.
    expect(group?.note).toMatch(/reconnect|log/i);
  });

  it("fails a Target without room for the images, in units a human reads", () => {
    const preflight = evaluateProbe(parseProbe(goodProbe.replace("disk\t52428800", "disk\t2097152")));
    const disk = preflight.checks.find((check) => check.id === "disk");
    expect(disk?.ok).toBe(false);
    expect(disk?.detail).toContain("2.0 GiB");
    // Nothing to run: the operator has to free space or pick another Target.
    expect(disk?.remedy).toBeUndefined();
  });

  // A stopped daemon and a socket the operator may not open both surface as
  // "docker info failed", and only one of them is fixed by a usermod.
  it("tells a stopped daemon apart from a permission problem", () => {
    const stopped = evaluateProbe(
      parseProbe(
        `${goodProbe.replace("docker-group\tyes", "docker-group\tno")}\ndocker-error\tfailed to connect to the docker API at unix:///var/run/docker.sock; check if the daemon is running`,
      ),
    );
    const check = stopped.checks.find((check) => check.id === "docker-group");
    expect(check?.detail).toMatch(/daemon is not answering/);
    expect(check?.remedy).toBe("systemctl start docker");
  });

  it("does not blame the socket on a Target that has no Docker at all", () => {
    const check = evaluateProbe(parseProbe("user\top\n")).checks.find(
      (check) => check.id === "docker-group",
    );
    expect(check?.detail).toMatch(/install Docker first/);
    expect(check?.remedy).toBeUndefined();
  });

  // The remedy names an account and is run on the Target, so it is quoted like
  // anything else that reaches a shell.
  it("quotes the account name in the remedy", () => {
    const probe = parseProbe(
      `${goodProbe.replace("docker-group\tyes", "docker-group\tno").replace("user\top", "user\tan operator")}\ndocker-error\tconnect: permission denied`,
    );
    const check = evaluateProbe(probe).checks.find((check) => check.id === "docker-group");
    expect(check?.remedy).toBe("usermod -aG docker 'an operator'");
  });

  it("accepts both architectures the images are built for", () => {
    for (const arch of ["x86_64", "aarch64", "arm64"]) {
      const probe = parseProbe(goodProbe.replace("arch\tx86_64", `arch\t${arch}`));
      expect(evaluateProbe(probe).checks.find((check) => check.id === "arch")?.ok).toBe(true);
    }
    const other = parseProbe(goodProbe.replace("arch\tx86_64", "arch\tarmv7l"));
    expect(evaluateProbe(other).checks.find((check) => check.id === "arch")?.ok).toBe(false);
  });

  it("treats an unreported check as failed rather than passing on silence", () => {
    const preflight = evaluateProbe({});
    expect(preflight.ok).toBe(false);
    expect(preflight.checks.every((check) => !check.ok)).toBe(true);
    expect(preflight.canElevate).toBe(false);
  });
});

describe("probeScript", () => {
  it("quotes the install directory it walks up from", () => {
    expect(probeScript("/home/op/a dir")).toContain("'/home/op/a dir'");
  });
});

describe("formatPreflight", () => {
  it("prints the fix with the sudo a human would have to type", () => {
    const report = formatPreflight(evaluateProbe(parseProbe("user\top\narch\tx86_64\ndisk\t52428800\n")));
    expect(report).toContain("sudo sh -c");
    expect(report).toContain("get.docker.com");
  });

  it("says nothing about fixes when there is nothing to fix", () => {
    expect(formatPreflight(evaluateProbe(parseProbe(goodProbe)))).not.toMatch(/sudo/);
  });
});
