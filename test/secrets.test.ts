import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { trustSecurityPolicy } from "../src/policy.js";
import { pathExists } from "../src/paths.js";
import {
  createComposeSecretSession,
  inspectSecrets,
  materializeSecretEnv,
  redactInstanceText,
  resolveSecrets,
  writePlainSecretEnvFile,
  writeSecretEnvFile,
} from "../src/secrets.js";
import type { BranchLiftConfig, RepoInfo } from "../src/types.js";

test("resolves scoped secrets without writing them into the worktree and redacts logs", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-secrets-"));
  const previousHome = process.env.BRANCHLIFT_HOME;
  const previousToken = process.env.BRANCHLIFT_TEST_TOKEN;
  process.env.BRANCHLIFT_HOME = home;
  process.env.BRANCHLIFT_TEST_TOKEN = "super-secret-value";
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  const config = baseConfig({
    token: {
      source: { env: "BRANCHLIFT_TEST_TOKEN" },
      target: { env: "APP_TOKEN" },
      scopes: ["compose", "sandbox"],
      required: true,
    },
  });
  try {
    await trustSecurityPolicy(repo, config);
    const resolved = await resolveSecrets(repo, config, "compose");
    assert.deepEqual(resolved.map(({ name, target }) => ({ name, target })), [{ name: "token", target: { env: "APP_TOKEN" } }]);
    const path = await materializeSecretEnv(repo, "feature-api", resolved);
    assert.ok(path);
    assert.equal(await readFile(path, "utf8"), "APP_TOKEN=super-secret-value\n");
    assert.equal(
      await redactInstanceText(repo, "feature-api", "authorization=super-secret-value"),
      "authorization=[REDACTED]",
    );
    assert.equal((await inspectSecrets(repo, config))[0]?.available, true);

    const session = await createComposeSecretSession(repo, config);
    assert.ok(session.envFile);
    assert.match(session.envFile, /\/operations\//);
    assert.equal(await readFile(session.envFile, "utf8"), "APP_TOKEN=super-secret-value\n");
    assert.equal((await stat(session.envFile)).mode & 0o777, 0o600);
    await session.close();
    assert.equal(await pathExists(session.envFile), false);
  } finally {
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    if (previousToken === undefined) delete process.env.BRANCHLIFT_TEST_TOKEN;
    else process.env.BRANCHLIFT_TEST_TOKEN = previousToken;
    await rm(home, { recursive: true, force: true });
  }
});

test("escapes interpolation for compose env files but writes verbatim docker-run files", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-secret-envfile-"));
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };
  const resolved = [{
    name: "db-password",
    target: { env: "DB_PASSWORD" },
    value: "pa$$w0rd\\slash",
    scopes: ["compose" as const, "sandbox" as const],
  }];
  try {
    const composeFile = join(root, "compose.env");
    await writeSecretEnvFile(composeFile, resolved);
    assert.equal(await readFile(composeFile, "utf8"), 'DB_PASSWORD=pa$$$$w0rd\\\\slash\n');
    const plainFile = join(root, "docker-run.env");
    await writePlainSecretEnvFile(plainFile, resolved);
    assert.equal(await readFile(plainFile, "utf8"), 'DB_PASSWORD=pa$$w0rd\\slash\n');
    assert.equal((await stat(plainFile)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects multiline secrets before environment materialization", async () => {  const root = await mkdtemp(join(tmpdir(), "branchlift-secret-newline-"));
  const secretFile = join(root, "secret.txt");
  await writeFile(secretFile, "line-one\nline-two\n");
  const repo: RepoInfo = { root, commonDir: join(root, ".git"), name: "demo", key: "demo-key" };
  const config = baseConfig({
    invalid: {
      source: { file: secretFile },
      target: { env: "INVALID_SECRET" },
      scopes: ["exec"],
      required: true,
    },
  });
  await trustSecurityPolicy(repo, config);
  await assert.rejects(resolveSecrets(repo, config, "exec"), /newline or NUL/);
  await rm(root, { recursive: true, force: true });
});

test("rejects repository-relative secret symlinks and traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-secret-symlink-"));
  const repository = join(root, "repo");
  const outside = join(root, "host-secret.txt");
  await mkdir(join(repository, "config"), { recursive: true });
  await writeFile(outside, "host-only-value\n");
  await symlink(outside, join(repository, "config", "token"));
  const repo: RepoInfo = { root: repository, commonDir: join(repository, ".git"), name: "demo", key: "demo-key" };
  const linked = baseConfig({
    token: {
      source: { file: "config/token" },
      target: { env: "TOKEN" },
      scopes: ["exec"],
      required: true,
    },
  });
  const traversing = baseConfig({
    token: {
      source: { file: "../host-secret.txt" },
      target: { env: "TOKEN" },
      scopes: ["exec"],
      required: true,
    },
  });
  try {
    await trustSecurityPolicy(repo, linked);
    await assert.rejects(resolveSecrets(repo, linked, "exec"), /must not contain symlinks/);
    await trustSecurityPolicy(repo, traversing);
    await assert.rejects(resolveSecrets(repo, traversing, "exec"), /escapes the repository/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function baseConfig(secrets: NonNullable<BranchLiftConfig["secrets"]>): BranchLiftConfig {
  return {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: [] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles: [] },
    secrets,
  };
}
