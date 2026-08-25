import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { previewInstances } from "../src/preview.js";
import { writeInstanceMetadata } from "../src/state.js";
import type { InstanceMetadata, RepoInfo } from "../src/types.js";

test("preview selects an exact branch and exposes normalized endpoints", async () => {
  const state = await mkdtemp(join(tmpdir(), "branchlift-preview-state-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = state;
  const root = join(state, "repo");
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "repo", key: "preview" };
  try {
    await writeInstanceMetadata(repo, "feature-api", instance(repo));
    const previews = await previewInstances(repo, "feature/api");
    assert.equal(previews.length, 1);
    assert.equal(previews[0]?.branch, "feature/api");
    assert.equal(previews[0]?.endpoints[0]?.url, "tcp://127.0.0.1:49152");
    await assert.rejects(previewInstances(repo, "missing"), /Instance not found/);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(state, { recursive: true, force: true });
  }
});

function instance(repo: RepoInfo): InstanceMetadata {
  return {
    version: 1,
    id: "id",
    branch: "feature/api",
    slug: "feature-api",
    repoKey: repo.key,
    sourceRoot: repo.root,
    worktreePath: repo.root,
    worktreeOwner: "external",
    snapshot: "dev",
    composeFile: "compose.yaml",
    composeFiles: ["compose.yaml"],
    overrideFile: join(repo.root, "override.yaml"),
    volumeRoot: join(repo.root, "volumes"),
    composeProject: "branchlift-preview",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    ports: [{ service: "api", target: 3000, protocol: "tcp", host: "0.0.0.0", port: 49152 }],
    copyStrategy: "apfs-clone",
  };
}
