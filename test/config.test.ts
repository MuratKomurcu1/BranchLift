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
  assert.deepEqual(loaded.compose.statefulServices, ["postgres"]);
  assert.match(await readFile(join(root, "branchlift.yaml"), "utf8"), /Commit this file/);
});
