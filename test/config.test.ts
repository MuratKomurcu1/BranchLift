import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeConfig, loadConfig } from "../src/config.js";
import type { RepoInfo } from "../src/types.js";
import { hasDockerComposeCli } from "./docker-availability.js";

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

test("merges multiple Compose files and loads legacy single-file config", { skip: !hasDockerComposeCli }, async () => {
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

test("auto-discovers the standard Compose override and existing local env files", { skip: !hasDockerComposeCli }, async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-config-auto-"));
  await writeFile(
    join(root, "compose.yaml"),
    `services:\n  mysql:\n    image: mysql:8.4\n    volumes: [mysql_data:/var/lib/mysql]\nvolumes:\n  mysql_data: {}\n`,
  );
  await writeFile(join(root, "compose.override.yaml"), `services:\n  mysql:\n    ports: ["3306:3306"]\n`);
  await writeFile(join(root, ".env.local"), "MYSQL_PASSWORD=local\n");
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };

  const preview = await initializeConfig(repo, undefined, { write: false });

  assert.equal(preview.written, false);
  assert.deepEqual(preview.config.compose.files, ["compose.yaml", "compose.override.yaml"]);
  assert.deepEqual(preview.config.worktree.copyFiles, [".env.local"]);
  assert.deepEqual(preview.inspection.ports.map(({ target }) => target), [3306]);
  await assert.rejects(readFile(join(root, "branchlift.yaml")), /ENOENT/);
});

test("loads strict sandbox, secret broker, and loopback UI policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-config-security-"));
  await writeFile(join(root, "compose.yaml"), "services:\n  redis:\n    image: redis:7\n    volumes: [data:/data]\nvolumes:\n  data: {}\n");
  await writeFile(
    join(root, "branchlift.yaml"),
    `version: 1
compose:
  files: [compose.yaml]
  statefulServices: [redis]
snapshot:
  default: dev
  healthTimeoutSeconds: 120
  seed: []
worktree:
  copyFiles: []
security:
  sandbox:
    backend: docker
    image: node:22-bookworm-slim
    network: backend
    readOnlyRoot: true
    memory: 2g
    cpus: 1.5
    pidsLimit: 256
  allowHostAgentCommands: false
  allowSecretCommands: false
secrets:
  api:
    source: { env: TEST_API_TOKEN }
    target: { env: API_TOKEN }
    scopes: [sandbox, exec]
    required: true
ui: { host: 127.0.0.1, port: 7788 }
`,
  );
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };

  const loaded = await loadConfig(repo);
  assert.equal(loaded.security?.sandbox.network, "backend");
  assert.equal(loaded.security?.sandbox.cpus, 1.5);
  assert.deepEqual(loaded.secrets?.api?.target, { env: "API_TOKEN" });
  assert.deepEqual(loaded.secrets?.api?.scopes, ["sandbox", "exec"]);
  assert.equal(loaded.ui?.host, "127.0.0.1");

  await writeFile(
    join(root, "branchlift.yaml"),
    (await readFile(join(root, "branchlift.yaml"), "utf8"))
      .replace("target: { env: API_TOKEN }", "target: { file: \"/run/secrets/token,readonly\" }"),
  );
  await assert.rejects(loadConfig(repo), /absolute path below \/run\/secrets/);
});
