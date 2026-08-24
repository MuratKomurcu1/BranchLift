import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BranchLiftError } from "../src/errors.js";
import {
  acquireLock,
  listLocks,
  lockPath,
  removeStaleLock,
  withLock,
} from "../src/lock.js";
import type { RepoInfo } from "../src/types.js";

test("an active cross-process lock rejects a competing operation and releases cleanly", async () => {
  await withState(async (repo) => {
    await withLock(repo, "instance:feature/api", "reset", async () => {
      const locks = await listLocks(repo);
      assert.equal(locks.length, 1);
      assert.equal(locks[0]?.status, "active");
      assert.equal(locks[0]?.metadata?.operation, "reset");
      await withLock(repo, "instance:feature/other", "start", async () => undefined);

      await assert.rejects(
        acquireLock(repo, "instance:feature/api", "destroy"),
        (error: unknown) => {
          assert.ok(error instanceof BranchLiftError);
          assert.match(error.message, /Another BranchLift operation owns instance:feature\/api/);
          assert.match(error.hint ?? "", /pid/);
          return true;
        },
      );
    });
    assert.deepEqual(await listLocks(repo), []);
  });
});

test("doctor-style recovery removes a dead-owner lock before retry", async () => {
  await withState(async (repo) => {
    const path = lockPath(repo, "snapshot:dev");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      version: 1,
      token: "dead-token",
      scope: "snapshot:dev",
      operation: "snapshot create",
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`);

    assert.equal((await listLocks(repo))[0]?.status, "stale");
    await assert.rejects(acquireLock(repo, "snapshot:dev", "snapshot delete"), /Another BranchLift operation/);
    assert.equal(await removeStaleLock(repo, path), true);
    await withLock(repo, "snapshot:dev", "snapshot delete", async () => undefined);
    assert.deepEqual(await listLocks(repo), []);
  });
});

test("withLock releases ownership when the protected operation throws", async () => {
  await withState(async (repo) => {
    await assert.rejects(
      withLock(repo, "instance:broken", "start", async () => {
        throw new Error("expected failure");
      }),
      /expected failure/,
    );
    await withLock(repo, "instance:broken", "destroy", async () => undefined);
  });
});

test("never guesses that a foreign-host lock is stale", async () => {
  await withState(async (repo) => {
    const path = lockPath(repo, "snapshot:shared-home");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      version: 1,
      token: "foreign-token",
      scope: "snapshot:shared-home",
      operation: "snapshot create",
      pid: 999_999,
      hostname: `${hostname()}-other`,
      createdAt: "2020-01-01T00:00:00.000Z",
    })}\n`);

    const inspection = (await listLocks(repo))[0];
    assert.equal(inspection?.status, "active");
    assert.match(inspection?.reason ?? "", /cannot be verified safely/);
    assert.equal(await removeStaleLock(repo, path), false);
  });
});

async function withState(run: (repo: RepoInfo) => Promise<void>): Promise<void> {
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-lock-"));
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
