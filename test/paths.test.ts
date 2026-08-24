import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloneDirectory, safeSlug } from "../src/paths.js";

test("safeSlug is deterministic and resists path traversal", () => {
  assert.equal(safeSlug("feature/auth"), safeSlug("feature/auth"));
  assert.doesNotMatch(safeSlug("../../etc/passwd"), /\//);
  assert.notEqual(safeSlug("feature/a"), safeSlug("feature-a"));
});

test("cloneDirectory creates an independent readable tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-copy-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "nested", "state.txt"), "golden-state\n");

  const strategy = await cloneDirectory(source, destination);

  assert.ok(["apfs-clone", "linux-reflink", "recursive-copy"].includes(strategy));
  assert.equal(await readFile(join(destination, "nested", "state.txt"), "utf8"), "golden-state\n");
});
