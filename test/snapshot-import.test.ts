import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { volumeDirectoryName } from "../src/compose.js";
import { makeTreeOwnerWritable, repoDataRoot } from "../src/paths.js";
import { trustSecurityPolicy } from "../src/policy.js";
import { importSnapshot, type SnapshotImportAdapter } from "../src/snapshot.js";
import type { BranchLiftConfig, ComposeInspection, RepoInfo } from "../src/types.js";

test("imports a consistent host-owned snapshot and restores source services", async () => {
  await withState(async (repo) => {
    const events: string[] = [];
    const adapter: SnapshotImportAdapter = {
      assertReady: async () => {
        events.push("ready");
      },
      runningServices: async () => ["db", "redis"],
      stop: async (_runtime, services) => {
        events.push(`stop:${services.join(",")}`);
      },
      start: async (_runtime, services) => {
        events.push(`start:${services.join(",")}`);
      },
      copy: async (_runtime, volume, destination) => {
        events.push(`copy:${volume.source}`);
        await writeFile(join(destination, `${volume.service}.state`), `${volume.source}-golden`);
      },
    };

    const result = await importSnapshot(repo, config(), inspection(), "from-dev", "demo-source", adapter);

    assert.equal(result.metadata.status, "ready");
    assert.equal(result.metadata.importedFromProject, "demo-source");
    assert.deepEqual(result.metadata.volumeNames, ["db_data", "redis_data"]);
    assert.ok((result.metadata.sizeBytes ?? 0) > 0);
    assert.deepEqual(events, ["ready", "stop:db,redis", "copy:db_data", "copy:redis_data", "start:db,redis"]);
    assert.equal(
      await readFile(join(result.path, "volumes", volumeDirectoryName("db_data"), "db.state"), "utf8"),
      "db_data-golden",
    );
  });
});

test("restarts source services and preserves diagnostics when import fails", async () => {
  await withState(async (repo) => {
    let restarted = false;
    const adapter: SnapshotImportAdapter = {
      assertReady: async () => undefined,
      runningServices: async () => ["db"],
      stop: async () => undefined,
      start: async () => {
        restarted = true;
      },
      copy: async () => {
        throw new Error("copy exploded");
      },
    };

    await assert.rejects(importSnapshot(repo, config(), inspection(), "broken", undefined, adapter), /Snapshot import failed/);
    assert.equal(restarted, true);
    const entries = await readdir(join(repoDataRoot(repo), "snapshots"));
    assert.ok(entries.some((entry) => entry.startsWith(".failed-broken-")));
  });
});

async function withState(run: (repo: RepoInfo) => Promise<void>): Promise<void> {
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-import-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = stateHome;
  const repo: RepoInfo = {
    root: join(stateHome, "repo"),
    commonDir: join(stateHome, "repo", ".git"),
    name: "demo",
    key: "demo-key",
  };
  try {
    await trustSecurityPolicy(repo, config());
    await run(repo);
  } finally {
    await makeTreeOwnerWritable(stateHome).catch(() => undefined);
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(stateHome, { recursive: true, force: true });
  }
}

function config(): BranchLiftConfig {
  return {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: ["db", "redis"] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles: [] },
  };
}

function inspection(): ComposeInspection {
  return {
    file: "compose.yaml",
    files: ["compose.yaml"],
    services: ["db", "redis"],
    inferredStatefulServices: ["redis"],
    postgresServices: ["db"],
    postgresDataDirectories: {},
    mysqlServices: [],
    serviceCommands: {},
    volumes: [
      { source: "db_data", target: "/var/lib/postgresql/data", service: "db", readOnly: false, external: false },
      { source: "redis_data", target: "/data", service: "redis", readOnly: false, external: false },
    ],
    bindMounts: [],
    ports: [],
    blockers: [],
    warnings: [],
    recommendations: [],
  };
}
