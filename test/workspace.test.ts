import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../src/process.js";
import type { InstanceMetadata, RepoInfo } from "../src/types.js";
import {
  createWorkspaceTask,
  deleteWorkspaceTask,
  inspectWorkspaceDiff,
  listWorkspaceTasks,
  moveWorkspaceTask,
} from "../src/workspace.js";
import { writeInstanceMetadata } from "../src/state.js";

test("stores prompts privately and moves tasks through the workspace board", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-workspace-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  try {
    const task = await createWorkspaceTask(repo, {
      title: "Fix authentication",
      prompt: "Inspect the auth middleware and add a regression test.",
      branch: "agent/fix-auth",
      agent: "codex",
      status: "ready",
    });
    assert.equal(task.status, "ready");
    assert.equal((await listWorkspaceTasks(repo))[0]?.prompt, "Inspect the auth middleware and add a regression test.");
    assert.equal((await moveWorkspaceTask(repo, task.id, "review")).status, "review");
    assert.equal((await deleteWorkspaceTask(repo, task.id)).id, task.id);
    assert.deepEqual(await listWorkspaceTasks(repo), []);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("returns a bounded diff only for a registered instance worktree", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-diff-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const root = join(home, "repo");
  const worktree = join(root, "agent-worktree");
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };
  try {
    await mkdir(worktree, { recursive: true });
    await runCommand("git", ["init", "-q"], { cwd: worktree });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: worktree });
    await runCommand("git", ["config", "user.name", "Test"], { cwd: worktree });
    await writeFile(join(worktree, "app.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "app.ts"], { cwd: worktree });
    await runCommand("git", ["commit", "-qm", "initial"], { cwd: worktree });
    await writeFile(join(worktree, "app.ts"), "export const value = 2;\n");
    const instance: InstanceMetadata = {
      version: 1, id: "instance", branch: "agent/fix", slug: "agent-fix", repoKey: repo.key, sourceRoot: root,
      worktreePath: worktree, worktreeOwner: "external", snapshot: "dev", composeFile: "compose.yaml",
      overrideFile: join(home, "override.yaml"), composeProject: "branchlift-test", createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), status: "stopped", ports: [], copyStrategy: "empty",
    };
    await writeInstanceMetadata(repo, instance.slug, instance);
    const diff = await inspectWorkspaceDiff(repo, "agent/fix");
    assert.match(diff.status, /app\.ts/);
    assert.match(diff.stat, /1 insertion.*1 deletion/);
    assert.match(diff.patch, /value = 2/);
    await assert.rejects(inspectWorkspaceDiff(repo, "missing"), /Instance not found/);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
