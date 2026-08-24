import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkSnapshot } from "../src/benchmark.js";
import { volumeDirectoryName } from "../src/compose.js";
import { snapshotRoot } from "../src/paths.js";
import { writeSnapshotMetadata } from "../src/state.js";
import type { RepoInfo, SnapshotMetadata } from "../src/types.js";

test("benchmarks immutable state clones and cleans temporary copies", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-benchmark-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = stateHome;
  const repo: RepoInfo = { root: stateHome, commonDir: join(stateHome, ".git"), name: "demo", key: "demo-key" };
  const metadata: SnapshotMetadata = {
    version: 1,
    name: "dev",
    repoKey: repo.key,
    sourceRoot: repo.root,
    composeFile: "compose.yaml",
    composeProject: "test",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "ready",
    volumeNames: ["data"],
    sizeBytes: 12,
  };

  try {
    const volume = join(snapshotRoot(repo, "dev"), "volumes", volumeDirectoryName("data"));
    await mkdir(volume, { recursive: true });
    await writeFile(join(volume, "state.txt"), "golden-state");
    await writeSnapshotMetadata(repo, "dev", metadata);

    const result = await benchmarkSnapshot(repo, "dev", 3);

    assert.equal(result.iterations, 3);
    assert.equal(result.samplesMs.length, 3);
    assert.equal(result.logicalBytes, 12);
    assert.ok(result.medianMs >= 0);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(stateHome, { recursive: true, force: true });
  }
});
