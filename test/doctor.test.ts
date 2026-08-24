import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { volumeDirectoryName } from "../src/compose.js";
import { applyDoctorFixes, auditState } from "../src/doctor.js";
import { listLocks, lockPath } from "../src/lock.js";
import { instanceRoot, repoDataRoot, snapshotRoot } from "../src/paths.js";
import {
  readInstanceMetadata,
  writeInstanceMetadata,
  writeSnapshotMetadata,
} from "../src/state.js";
import type { InstanceMetadata, RepoInfo, SnapshotMetadata } from "../src/types.js";

test("doctor finds orphan Docker projects and reconciles stale running metadata", async () => {
  await withState(async (repo) => {
    const metadata = await createHealthyState(repo, "running");
    const orphan = `bl-${repo.key.slice(-12)}-orphan-runtime`;
    const projects = new Map([
      [orphan, { containers: 1, running: 1 }],
      ["foreign-compose-project", { containers: 1, running: 1 }],
    ]);

    const report = await auditState(repo, projects);
    assert.ok(report.findings.some(({ code }) => code === "stale-running-status"));
    assert.ok(report.findings.some(({ code, target }) => code === "orphan-runtime" && target === orphan));
    assert.ok(!report.findings.some(({ target }) => target === "foreign-compose-project"));

    const staleOnly = { ...report, findings: report.findings.filter(({ code }) => code === "stale-running-status") };
    const fixes = await applyDoctorFixes(repo, staleOnly);
    assert.deepEqual(fixes, [`Reconciled ${metadata.branch} to stopped.`]);
    assert.equal((await readInstanceMetadata(repo, metadata.slug)).status, "stopped");
  });
});

test("doctor reports missing snapshot and runtime files without mutating them", async () => {
  await withState(async (repo) => {
    const metadata = instance(repo, "feature/broken", "feature-broken", "missing", "stopped");
    await writeInstanceMetadata(repo, metadata.slug, metadata);
    const invalidRoot = join(repoDataRoot(repo), "instances", "invalid");
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(join(invalidRoot, "metadata.json"), "{}\n");
    const staleLock = lockPath(repo, "instance:abandoned");
    await mkdir(dirname(staleLock), { recursive: true });
    await writeFile(staleLock, `${JSON.stringify({
      version: 1,
      token: "dead-token",
      scope: "instance:abandoned",
      operation: "reset",
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);

    const report = await auditState(repo);
    const codes = new Set(report.findings.map(({ code }) => code));
    assert.ok(codes.has("instance-snapshot-missing"));
    assert.ok(codes.has("instance-worktree-missing"));
    assert.ok(codes.has("instance-override-missing"));
    assert.ok(codes.has("instance-compose-missing"));
    assert.ok(codes.has("state-metadata-invalid"));
    assert.ok(codes.has("stale-lock"));
    assert.ok(report.findings.filter(({ severity }) => severity === "error").every(({ fixable }) => !fixable));
    assert.ok((await applyDoctorFixes(repo, report)).some((message) => message.includes("stale operation lock")));
    assert.deepEqual(await listLocks(repo), []);
  });
});

async function createHealthyState(repo: RepoInfo, status: InstanceMetadata["status"]): Promise<InstanceMetadata> {
  const snapshotName = "dev";
  const snapshotMetadata: SnapshotMetadata = {
    version: 1,
    name: snapshotName,
    repoKey: repo.key,
    sourceRoot: repo.root,
    composeFile: "compose.yaml",
    composeProject: `bl-${repo.key.slice(-12)}-snapshot-dev`,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    status: "ready",
    volumeNames: ["db-data"],
    sizeBytes: 12,
  };
  await mkdir(join(snapshotRoot(repo, snapshotName), "volumes", volumeDirectoryName("db-data")), { recursive: true });
  await writeSnapshotMetadata(repo, snapshotName, snapshotMetadata);

  const metadata = instance(repo, "feature/api", "feature-api", snapshotName, status);
  await mkdir(metadata.worktreePath, { recursive: true });
  await writeFile(join(metadata.worktreePath, metadata.composeFile), "services: {}\n");
  await mkdir(instanceRoot(repo, metadata.slug), { recursive: true });
  await writeFile(metadata.overrideFile, "services: {}\n");
  await writeInstanceMetadata(repo, metadata.slug, metadata);
  return metadata;
}

async function withState(run: (repo: RepoInfo) => Promise<void>): Promise<void> {
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-doctor-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = stateHome;
  const repo: RepoInfo = {
    root: join(stateHome, "repo"),
    commonDir: join(stateHome, "repo", ".git"),
    name: "demo",
    key: "demo-abcdefghijkl",
  };
  try {
    await run(repo);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(stateHome, { recursive: true, force: true });
  }
}

function instance(
  repo: RepoInfo,
  branch: string,
  slug: string,
  snapshot: string,
  status: InstanceMetadata["status"],
): InstanceMetadata {
  const worktreePath = join(repo.root, "worktrees", slug);
  return {
    version: 1,
    id: "instance-id",
    branch,
    slug,
    repoKey: repo.key,
    sourceRoot: repo.root,
    worktreePath,
    snapshot,
    composeFile: "compose.yaml",
    overrideFile: join(instanceRoot(repo, slug), "compose.override.yaml"),
    composeProject: `bl-${repo.key.slice(-12)}-instance-${slug}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    ports: status === "running" ? [{ service: "db", target: 5432, protocol: "tcp", host: "0.0.0.0", port: 49152 }] : [],
    copyStrategy: "apfs-clone",
  };
}
