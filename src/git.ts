import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { BranchLiftError } from "./errors.js";
import { pathExists, repoKey } from "./paths.js";
import { runCommand } from "./process.js";
import type { RepoInfo } from "./types.js";

export async function discoverRepo(cwd = process.cwd()): Promise<RepoInfo> {
  const rootResult = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    allowFailure: true,
  });
  if (rootResult.exitCode !== 0) {
    throw new BranchLiftError("BranchLift must run inside a Git repository.", "Initialize the project with git init first.");
  }

  const root = resolve(rootResult.stdout.trim());
  const commonResult = await runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: root });
  const commonValue = commonResult.stdout.trim();
  const commonDir = resolve(isAbsolute(commonValue) ? commonValue : resolve(root, commonValue));
  return { root, commonDir, name: basename(root), key: repoKey(commonDir) };
}

export async function currentBranch(repo: RepoInfo): Promise<string> {
  const result = await runCommand("git", ["branch", "--show-current"], { cwd: repo.root });
  const branch = result.stdout.trim();
  if (branch === "") throw new BranchLiftError("Detached HEAD is not supported for this operation.");
  return branch;
}

export async function createWorktree(repo: RepoInfo, branch: string, target: string): Promise<void> {
  await assertValidBranch(repo, branch);
  if (await pathExists(target)) {
    throw new BranchLiftError(`Worktree path already exists: ${target}`);
  }
  await mkdir(dirname(target), { recursive: true });

  const exists = await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (exists.exitCode === 0) {
    await runCommand("git", ["worktree", "add", target, branch], { cwd: repo.root });
  } else {
    await runCommand("git", ["worktree", "add", "-b", branch, target, "HEAD"], {
      cwd: repo.root,
    });
  }
}

export async function removeCleanWorktree(repo: RepoInfo, target: string): Promise<void> {
  if (!(await pathExists(target))) return;
  const status = await runCommand("git", ["status", "--porcelain"], { cwd: target });
  if (status.stdout.trim() !== "") {
    throw new BranchLiftError(
      `Refusing to remove a dirty worktree: ${target}`,
      "Commit or move its changes, then run destroy --worktree again.",
    );
  }
  await runCommand("git", ["worktree", "remove", target], { cwd: repo.root, stdio: "inherit" });
}

export async function assertCommittedHead(repo: RepoInfo): Promise<void> {
  const result = await runCommand("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    throw new BranchLiftError("The repository has no commit yet.", "Create an initial commit before spawning worktrees.");
  }
}

async function assertValidBranch(repo: RepoInfo, branch: string): Promise<void> {
  const result = await runCommand("git", ["check-ref-format", "--branch", branch], {
    cwd: repo.root,
    allowFailure: true,
  });
  if (result.exitCode !== 0) throw new BranchLiftError(`Invalid Git branch name: ${branch}`);
}
