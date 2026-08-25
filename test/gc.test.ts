import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectGarbage, parseAge } from "../src/gc.js";
import { instanceRoot, pathExists, safeSlug } from "../src/paths.js";
import { destroyInstanceIfUnchanged } from "../src/runtime.js";
import { writeInstanceMetadata } from "../src/state.js";
import type { InstanceMetadata, RepoInfo } from "../src/types.js";

test("gc removes only old stopped or failed instances and reports reclaimed state", async () => {
  await withState(async (repo) => {
    const old = instance(repo, "old-stopped", "stopped", "2026-01-01T00:00:00.000Z");
    const fresh = instance(repo, "fresh-stopped", "stopped", "2026-01-30T00:00:00.000Z");
    const running = instance(repo, "old-running", "running", "2026-01-01T00:00:00.000Z");
    for (const metadata of [old, fresh, running]) {
      await writeInstanceMetadata(repo, metadata.slug, metadata);
      await writeFile(join(instanceRoot(repo, metadata.slug), "payload.bin"), "state-payload");
    }

    const result = await collectGarbage(repo, {
      olderThanMs: parseAge("7d")!,
      dryRun: false,
      now: Date.parse("2026-02-01T00:00:00.000Z"),
    });

    assert.equal(result.scanned, 3);
    assert.equal(result.eligible, 1);
    assert.equal(result.removed, 1);
    assert.ok(result.reclaimedBytes > 0);
    assert.equal(await pathExists(instanceRoot(repo, old.slug)), false);
    assert.equal(await pathExists(instanceRoot(repo, fresh.slug)), true);
    assert.equal(await pathExists(instanceRoot(repo, running.slug)), true);
  });
});

test("gc dry-run is non-mutating and conditional destroy rejects stale candidates", async () => {
  await withState(async (repo) => {
    const candidate = instance(repo, "candidate", "failed", "2026-01-01T00:00:00.000Z");
    await writeInstanceMetadata(repo, candidate.slug, candidate);

    const preview = await collectGarbage(repo, {
      olderThanMs: parseAge("1d")!,
      dryRun: true,
      now: Date.parse("2026-02-01T00:00:00.000Z"),
    });
    assert.equal(preview.entries[0]?.action, "would-remove");
    assert.equal(await pathExists(instanceRoot(repo, candidate.slug)), true);

    const raced = await destroyInstanceIfUnchanged(
      repo,
      { branch: candidate.branch, status: candidate.status, updatedAt: "2025-12-31T00:00:00.000Z" },
      false,
    );
    assert.equal(raced.removed, false);
    assert.match(raced.removed ? "" : raced.reason, /changed/);
    assert.equal(await pathExists(instanceRoot(repo, candidate.slug)), true);
  });
});

test("parses explicit gc age units and rejects unsafe values", () => {
  assert.equal(parseAge("30m"), 1_800_000);
  assert.equal(parseAge("24h"), 86_400_000);
  assert.equal(parseAge("2w"), 1_209_600_000);
  assert.equal(parseAge("0d"), undefined);
  assert.equal(parseAge("7"), undefined);
});

async function withState(run: (repo: RepoInfo) => Promise<void>): Promise<void> {
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-gc-"));
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

function instance(
  repo: RepoInfo,
  branch: string,
  status: InstanceMetadata["status"],
  updatedAt: string,
): InstanceMetadata {
  const slug = safeSlug(branch);
  return {
    version: 1,
    id: `${branch}-id`,
    branch,
    slug,
    repoKey: repo.key,
    sourceRoot: repo.root,
    worktreePath: repo.root,
    worktreeOwner: "external",
    snapshot: "dev",
    composeFile: "compose.yaml",
    overrideFile: join(instanceRoot(repo, slug), "missing.override.yaml"),
    volumeRoot: join(instanceRoot(repo, slug), "volumes"),
    composeProject: `runtime-${branch}`,
    createdAt: updatedAt,
    updatedAt,
    status,
    ports: [],
    copyStrategy: "recursive-copy",
  };
}
