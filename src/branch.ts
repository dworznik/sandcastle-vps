const BRANCH_PREFIX = "sandcastle/";
const MAX_SLUG_LENGTH = 48;

/** Derive a Task Branch name from a task description: `sandcastle/<slug>`. */
export const taskBranch = (task: string): string => {
  const slug = task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
  if (!slug) {
    throw new Error("Cannot derive a branch name from an empty task description");
  }
  return `${BRANCH_PREFIX}${slug}`;
};

/**
 * Validate an explicitly requested branch name. Any valid git branch name is
 * accepted; names that could escape refs/heads or break `git worktree` are not.
 */
export const validateBranch = (branch: string): string => {
  const invalid =
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    /[\s~^:?*[\\]|\.\.|@\{|\/\//.test(branch);
  if (invalid) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  return branch;
};
