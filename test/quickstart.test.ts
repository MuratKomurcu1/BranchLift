import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scaffoldDemoProject } from "../src/quickstart.js";
import { runCommand } from "../src/process.js";

test("scaffolds a committed zero-configuration PostgreSQL and Redis demo", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-demo-parent-"));
  const destination = join(root, "demo");
  try {
    const repo = await scaffoldDemoProject(destination);
    assert.equal(repo.root, await realpath(destination));
    const compose = await readFile(join(destination, "compose.yaml"), "utf8");
    assert.match(compose, /postgres:16-alpine/);
    assert.match(compose, /redis:7-alpine/);
    assert.equal((await runCommand("git", ["status", "--porcelain"], { cwd: destination })).stdout, "");
    await assert.rejects(scaffoldDemoProject(destination), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
