import { describe, expect, it } from "vitest";
import { taskBranch, validateBranch } from "./branch.js";

describe("taskBranch", () => {
  it("slugifies a task description under the sandcastle/ prefix", () => {
    expect(taskBranch("Fix the login redirect bug")).toBe(
      "sandcastle/fix-the-login-redirect-bug",
    );
  });

  it("strips punctuation and collapses separators", () => {
    expect(taskBranch("Add   OAuth2.0 (Google) support!")).toBe(
      "sandcastle/add-oauth2-0-google-support",
    );
  });

  it("truncates long descriptions without a trailing hyphen", () => {
    const branch = taskBranch(
      "Refactor the entire configuration subsystem to support hot reloading of every module",
    );
    expect(branch.length).toBeLessThanOrEqual("sandcastle/".length + 48);
    expect(branch.endsWith("-")).toBe(false);
  });

  it("rejects tasks that yield an empty slug", () => {
    expect(() => taskBranch("!!! ???")).toThrow(/empty task/);
  });
});

describe("validateBranch", () => {
  it("accepts normal branch names", () => {
    expect(validateBranch("sandcastle/my-task")).toBe("sandcastle/my-task");
    expect(validateBranch("feat/thing")).toBe("feat/thing");
  });

  it.each([
    "-leading-dash",
    "/leading-slash",
    "trailing-slash/",
    "has space",
    "has..dotdot",
    "has~tilde",
    "has^caret",
    "has:colon",
    "has?question",
    "has*star",
    "has[bracket",
    "double//slash",
    "ends.lock",
    "at@{brace",
  ])("rejects %s", (branch) => {
    expect(() => validateBranch(branch)).toThrow(/Invalid branch name/);
  });
});
