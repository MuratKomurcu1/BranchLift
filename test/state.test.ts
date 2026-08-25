import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BranchLiftError } from "../src/errors.js";
import { makeTreeReadOnly, pathExists, repoDataRoot, snapshotRoot } from "../src/paths.js";
import {
  deleteSnapshot,
  isSnapshotMetadata,
  listSnapshots,
  writeInstanceMetadata,
  writeSnapshotMetadata,
} from "../src/state.js";
import type { InstanceMetadata, RepoInfo, SnapshotMetadata } from "../src/types.js";

test("lists snapshots newest first and deletes an unused snapshot", async () => {
  await withState(async (repo) => {
    await writeSnapshotMetadata(repo, "older", snapshot(repo, "older", "2026-01-01T00:00:00.000Z"));
    await writeSnapshotMetadata(repo, "newer", snapshot(repo, "newer", "2026-02-01T00:00:00.000Z"));

    assert.deepEqual(
      (await listSnapshots(repo)).map(({ name }) => name),
      ["newer", "older"],
    );

    const olderVolume = join(snapshotRoot(repo, "older"), "volumes", "db-data");
    await mkdir(olderVolume, { recursive: true });
    await writeFile(join(olderVolume, "state"), "immutable");
    await makeTreeReadOnly(join(snapshotRoot(repo, "older"), "volumes"));
    await deleteSnapshot(repo, "older");
    assert.equal(await pathExists(snapshotRoot(repo, "older")), false);
    assert.deepEqual(
      (await listSnapshots(repo)).map(({ name }) => name),
      ["newer"],
    );
  });
});

test("refuses to delete a snapshot referenced by an instance", async () => {
  await withState(async (repo) => {
    await writeSnapshotMetadata(repo, "dev", snapshot(repo, "dev", "2026-01-01T00:00:00.000Z"));
    await writeInstanceMetadata(repo, "feature-api", instance(repo, "feature/api", "feature-api", "dev"));

    await assert.rejects(deleteSnapshot(repo, "dev"), (error: unknown) => {
      assert.ok(error instanceof BranchLiftError);
      assert.match(error.message, /still used by 1 instance/);
      assert.match(error.hint ?? "", /feature\/api/);
      return true;
    });
    assert.equal(await pathExists(snapshotRoot(repo, "dev")), true);
  });
});

test("refuses snapshot deletion when instance metadata cannot be audited", async () => {
  await withState(async (repo) => {
    await writeSnapshotMetadata(repo, "dev", snapshot(repo, "dev", "2026-01-01T00:00:00.000Z"));
    const brokenRoot = join(repoDataRoot(repo), "instances", "broken");
    await mkdir(brokenRoot, { recursive: true });
    await writeFile(join(brokenRoot, "metadata.json"), "{not-json");

    await assert.rejects(deleteSnapshot(repo, "dev"), /Cannot prove the snapshot is unused/);
    assert.equal(await pathExists(snapshotRoot(repo, "dev")), true);
  });
});

test("validates imported database layout metadata", () => {
  const repo = { root: "/repo", commonDir: "/repo/.git", name: "demo", key: "demo-key" };
  const metadata = {
    ...snapshot(repo, "imported", "2026-01-01T00:00:00.000Z"),
    importedFromProject: "existing-stack",
    postgresDataDirectories: { postgres: "/var/lib/postgresql/data", archive: false },
    mysqlLowerCaseTableNames: 1,
  };
  assert.equal(isSnapshotMetadata(metadata), true);
  assert.equal(isSnapshotMetadata({ ...metadata, postgresDataDirectories: { postgres: 42 } }), false);
  assert.equal(isSnapshotMetadata({ ...metadata, mysqlLowerCaseTableNames: 3 }), false);
  assert.equal(isSnapshotMetadata({ ...metadata, mysqlLowerCaseTableNames: "1" }), false);
});

async function withState(run: (repo: RepoInfo) => Promise<void>): Promise<void> {
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-state-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = stateHome;
  const repo: RepoInfo = {
    root: join(stateHome, "repo"),
    commonDir: join(stateHome, "repo", ".git"),
    name: "demo",
    key: "demo-key",
  };
  try {
    await run(repo);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(stateHome, { recursive: true, force: true });
  }
}

function snapshot(repo: RepoInfo, name: string, createdAt: string): SnapshotMetadata {
  return {
    version: 1,
    name,
    repoKey: repo.key,
    sourceRoot: repo.root,
    composeFile: "compose.yaml",
    composeProject: `snapshot-${name}`,
    createdAt,
    completedAt: createdAt,
    status: "ready",
    volumeNames: ["db-data"],
    sizeBytes: 12,
  };
}

function instance(repo: RepoInfo, branch: string, slug: string, snapshotName: string): InstanceMetadata {
  return {
    version: 1,
    id: "instance-id",
    branch,
    slug,
    repoKey: repo.key,
    sourceRoot: repo.root,
    worktreePath: join(repo.root, "worktree"),
    snapshot: snapshotName,
    composeFile: "compose.yaml",
    overrideFile: join(repo.root, "override.yaml"),
    composeProject: "runtime-feature-api",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "stopped",
    ports: [],
    copyStrategy: "apfs-clone",
  };
}
