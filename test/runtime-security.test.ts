import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorktree } from "../src/git.js";
import { copyConfiguredFiles } from "../src/runtime.js";
import { runCommand } from "../src/process.js";
import type { BranchLiftConfig, RepoInfo } from "../src/types.js";

function config(copyFiles: string[]): BranchLiftConfig {
  return {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: [] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles },
  };
}

test("copyFiles refuses source and destination symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-copy-security-"));
  const repoRoot = join(root, "repo");
  const targetRoot = join(root, "worktree");
  const outside = join(root, "outside");
  await Promise.all([mkdir(repoRoot), mkdir(targetRoot), mkdir(outside)]);
  const repo: RepoInfo = { root: repoRoot, commonDir: join(repoRoot, ".git"), name: "demo", key: "demo-key" };
  try {
    await writeFile(join(outside, "host-secret"), "do-not-copy");
    await symlink(join(outside, "host-secret"), join(repoRoot, ".env"));
    await assert.rejects(copyConfiguredFiles(repo, config([".env"]), targetRoot), /regular file, not a symlink/);

    await rm(join(repoRoot, ".env"));
    await mkdir(join(repoRoot, "nested"));
    await writeFile(join(repoRoot, "nested", "nested.env"), "safe=value\n");
    await symlink(outside, join(targetRoot, "nested"));
    await assert.rejects(
      copyConfiguredFiles(repo, config(["nested/nested.env"]), targetRoot),
      /unsafe path component/,
    );
    await assert.rejects(stat(join(outside, "nested.env")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree start points cannot be smuggled as git options", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-worktree-revision-"));
  const previousHome = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = join(root, "state");
  const repoRoot = join(root, "repo");
  const repo: RepoInfo = { root: repoRoot, commonDir: join(repoRoot, ".git"), name: "demo", key: "demo-key" };
  try {
    await mkdir(repoRoot);
    await runGit(repoRoot, ["init", "-q"]);
    await runGit(repoRoot, ["config", "user.email", "branchlift@example.test"]);
    await runGit(repoRoot, ["config", "user.name", "BranchLift Test"]);
    await writeFile(join(repoRoot, "file.txt"), "content\n");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-q", "-m", "init"]);
    await mkdir(join(repoRoot, "target"));
    for (const hostile of ["--force", "--quiet", "-b", "HEAD;rm-rf", "origin/main --force"]) {
      await assert.rejects(
        createWorktree(repo, "feature-x", join(repoRoot, "target", "wt"), hostile),
        /Unsafe worktree start point/,
      );
    }
    assert.deepEqual(await readdir(join(repoRoot, "target")), []);
    await createWorktree(repo, "feature-ok", join(repoRoot, "target", "ok"), "HEAD");
    await assert.rejects(
      createWorktree(repo, "feature-y", join(repoRoot, "target", "nope"), "refs/heads/feature-ok extra"),
      /Unsafe worktree start point/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

async function runGit(cwd: string, args: string[]): Promise<void> {
  await runCommand("git", args, { cwd });
}
