import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { volumeDirectoryName } from "../src/compose.js";
import { diffSnapshots, ensureSnapshotManifest } from "../src/manifest.js";
import { instanceRoot, makeTreeOwnerWritable, safeSlug, snapshotRoot } from "../src/paths.js";
import { commitSnapshotFromInstance } from "../src/snapshot.js";
import { trustSecurityPolicy } from "../src/policy.js";
import { writeInstanceMetadata, writeSnapshotMetadata } from "../src/state.js";
import type { BranchLiftConfig, ComposeInspection, InstanceMetadata, RepoInfo, SnapshotMetadata } from "../src/types.js";

test("commits an instance as a content-addressed child snapshot and produces a semantic diff", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-manifest-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  const volume = "db-data";
  try {
    await trustSecurityPolicy(repo, config());
    await writeSnapshotMetadata(repo, "dev", snapshot(repo, "dev", volume));
    const parentVolume = join(snapshotRoot(repo, "dev"), "volumes", volumeDirectoryName(volume));
    await mkdir(parentVolume, { recursive: true });
    await writeFile(join(parentVolume, "state.txt"), "golden\n");

    const slug = safeSlug("feature/api");
    const instanceVolumeRoot = join(instanceRoot(repo, slug), "volumes");
    await mkdir(join(instanceVolumeRoot, volumeDirectoryName(volume)), { recursive: true });
    await writeFile(join(instanceVolumeRoot, volumeDirectoryName(volume), "state.txt"), "mutated\n");
    await writeInstanceMetadata(repo, slug, instance(repo, volume, instanceVolumeRoot));

    const result = await commitSnapshotFromInstance(repo, config(), inspection(repo, volume), "feature-state", "feature/api");
    assert.equal(result.metadata.parentSnapshot, "dev");
    assert.equal(result.metadata.sourceInstance, "feature/api");
    assert.match(result.metadata.contentDigest ?? "", /^sha256:/);
    assert.equal(result.metadata.manifestFile, "manifest.json");
    assert.equal((await stat(join(snapshotRoot(repo, "feature-state"), "volumes", volumeDirectoryName(volume), "state.txt"))).mode & 0o222, 0);

    const manifest = await ensureSnapshotManifest(repo, "feature-state");
    assert.equal(manifest.entries.some(({ path, digest }) => path === "state.txt" && digest.startsWith("sha256:")), true);
    const diff = await diffSnapshots(repo, "dev", "feature-state");
    assert.equal(diff.modified, 1);
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.equal(diff.entries[0]?.path, "state.txt");
  } finally {
    await makeTreeOwnerWritable(home).catch(() => undefined);
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

function config(): BranchLiftConfig {
  return {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: ["db"] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles: [] },
  };
}

function inspection(repo: RepoInfo, volume: string): ComposeInspection {
  return {
    file: join(repo.root, "compose.yaml"),
    files: [join(repo.root, "compose.yaml")],
    services: ["db"],
    inferredStatefulServices: ["db"],
    postgresServices: [],
    postgresDataDirectories: {},
    mysqlServices: [],
    mongodbServices: [],
    kafkaServices: [],
    serviceCommands: {},
    volumes: [{ source: volume, target: "/data", service: "db", readOnly: false, external: false }],
    bindMounts: [],
    ports: [],
    blockers: [],
    warnings: [],
    recommendations: [],
  };
}

function snapshot(repo: RepoInfo, name: string, volume: string): SnapshotMetadata {
  return {
    version: 1,
    name,
    repoKey: repo.key,
    sourceRoot: repo.root,
    composeFile: "compose.yaml",
    composeFiles: ["compose.yaml"],
    composeProject: `snapshot-${name}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    volumeNames: [volume],
  };
}

function instance(repo: RepoInfo, volume: string, volumeRoot: string): InstanceMetadata {
  return {
    version: 1,
    id: "instance-id",
    branch: "feature/api",
    slug: safeSlug("feature/api"),
    repoKey: repo.key,
    sourceRoot: repo.root,
    worktreePath: join(repo.root, "worktree"),
    worktreeOwner: "external",
    snapshot: "dev",
    composeFile: "compose.yaml",
    composeFiles: ["compose.yaml"],
    overrideFile: join(instanceRoot(repo, safeSlug("feature/api")), "compose.override.yaml"),
    volumeRoot,
    managedVolumes: [{ source: volume, target: "/data", service: "db", readOnly: false, external: false }],
    composeProject: "runtime-feature-api",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "stopped",
    ports: [],
    copyStrategy: "recursive-copy",
  };
}
