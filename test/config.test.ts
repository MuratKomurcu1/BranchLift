import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeConfig, loadConfig } from "../src/config.js";
import type { RepoInfo } from "../src/types.js";

test("initializes and reloads a deterministic project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-config-"));
  await writeFile(
    join(root, "compose.yaml"),
    `services:\n  postgres:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata: {}\n`,
  );
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };

  const initialized = await initializeConfig(repo);
  const loaded = await loadConfig(repo);

  assert.deepEqual(loaded, initialized.config);
  assert.deepEqual(loaded.compose.files, ["compose.yaml"]);
  assert.deepEqual(loaded.compose.statefulServices, ["postgres"]);
  assert.match(await readFile(join(root, "branchlift.yaml"), "utf8"), /Commit this file/);
});

test("merges multiple Compose files and loads legacy single-file config", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-config-multi-"));
  await writeFile(
    join(root, "compose.yaml"),
    `services:\n  postgres:\n    image: postgres:16\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata: {}\n`,
  );
  await writeFile(
    join(root, "compose.dev.yaml"),
    `services:\n  postgres:\n    ports:\n      - "5432:5432"\n`,
  );
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };

  const initialized = await initializeConfig(repo, ["compose.yaml", "compose.dev.yaml"]);
  assert.deepEqual(initialized.config.compose.files, ["compose.yaml", "compose.dev.yaml"]);
  assert.deepEqual(initialized.inspection.files, [join(root, "compose.yaml"), join(root, "compose.dev.yaml")]);
  assert.deepEqual(initialized.inspection.ports.map(({ target }) => target), [5432]);

  await writeFile(
    join(root, "branchlift.yaml"),
    `version: 1\ncompose:\n  file: compose.yaml\n  statefulServices: [postgres]\nsnapshot:\n  default: dev\n  healthTimeoutSeconds: 120\n  seed: []\nworktree:\n  copyFiles: []\n`,
  );
  assert.deepEqual((await loadConfig(repo)).compose.files, ["compose.yaml"]);
});
