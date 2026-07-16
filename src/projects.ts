import { access } from "node:fs/promises";
import { basename, join } from "node:path";

export interface Project {
  readonly name: string;
  /** Absolute host path to the Project checkout. */
  readonly path: string;
  /** True when the Project ships its own .sandcastle/Dockerfile, in which
   *  case its own image (sandcastle convention: built via
   *  `sandcastle docker build-image` in that repo) is used instead of the
   *  shared default. */
  readonly hasOwnSandboxImage: boolean;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve a Project by convention: `name` is a directory under the workspace
 * root containing a git repo. Names are plain directory names — anything that
 * would traverse out of the workspace root is rejected.
 */
export const resolveProject = async (
  workspaceRoot: string,
  name: string,
): Promise<Project> => {
  if (name !== basename(name) || name === "." || name === "..") {
    throw new Error(`Invalid project name: ${name}`);
  }
  const path = join(workspaceRoot, name);
  if (!(await exists(join(path, ".git")))) {
    throw new Error(`Project "${name}" is not a git checkout under ${workspaceRoot}`);
  }
  return {
    name,
    path,
    hasOwnSandboxImage: await exists(join(path, ".sandcastle", "Dockerfile")),
  };
};
