import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runCommand } from "../src/process.js";
import type { InstanceMetadata } from "../src/types.js";

const enabled = process.env.BRANCHLIFT_E2E === "1";

test("creates two isolated stateful stacks and resets one to golden state", { skip: !enabled, timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-e2e-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-e2e-state-"));
  const cli = resolve("dist/src/cli.js");
  const env = { ...process.env, BRANCHLIFT_HOME: stateHome };

  try {
    await writeFile(join(root, "compose.yaml"), composeFixture());
    await writeFile(join(root, "branchlift.yaml"), configFixture());
    await run("git", ["init", "-b", "main"], root, env);
    await run("git", ["config", "user.email", "branchlift-test@example.invalid"], root, env);
    await run("git", ["config", "user.name", "BranchLift Test"], root, env);
    await run("git", ["add", "."], root, env);
    await run("git", ["commit", "-m", "fixture"], root, env);

    await run(process.execPath, [cli, "snapshot", "dev"], root, env);
    const first = JSON.parse(await run(process.execPath, [cli, "spawn", "agent-a", "--json"], root, env)) as InstanceMetadata;
    assert.equal(await probe(first, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");

    await sql(first, "UPDATE branchlift_probe SET value = 'changed' WHERE id = 1");
    assert.equal(await probe(first, "SELECT value FROM branchlift_probe WHERE id = 1"), "changed");

    const second = JSON.parse(await run(process.execPath, [cli, "spawn", "agent-b", "--json"], root, env)) as InstanceMetadata;
    assert.equal(await probe(second, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    assert.notEqual(first.ports.find((port) => port.service === "postgres")?.port, second.ports.find((port) => port.service === "postgres")?.port);

    const failedAgent = await runCommand(
      process.execPath,
      [cli, "spawn", "agent-c", "--", process.execPath, "-e", "process.exit(7)"],
      { cwd: root, env, allowFailure: true },
    );
    assert.equal(failedAgent.exitCode, 1);
    const afterAgentFailure = JSON.parse(
      await run(process.execPath, [cli, "list", "--json"], root, env),
    ) as InstanceMetadata[];
    assert.equal(afterAgentFailure.find((instance) => instance.branch === "agent-c")?.status, "running");

    await run(process.execPath, [cli, "reset", "agent-a"], root, env);
    const instances = JSON.parse(await run(process.execPath, [cli, "list", "--json"], root, env)) as InstanceMetadata[];
    const resetFirst = instances.find((instance) => instance.branch === "agent-a");
    assert.ok(resetFirst);
    assert.equal(await probe(resetFirst, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");

    await run(process.execPath, [cli, "destroy", "agent-a", "--worktree"], root, env);
    await run(process.execPath, [cli, "destroy", "agent-b", "--worktree"], root, env);
  } finally {
    const listed = await runCommand(process.execPath, [cli, "list", "--json"], { cwd: root, env, allowFailure: true });
    if (listed.exitCode === 0) {
      try {
        const instances = JSON.parse(listed.stdout) as InstanceMetadata[];
        for (const instance of instances) {
          await runCommand(process.execPath, [cli, "destroy", instance.branch, "--worktree"], {
            cwd: root,
            env,
            allowFailure: true,
          });
        }
      } catch {
        // Product assertions report the original failure; cleanup remains best-effort.
      }
    }
    await rm(stateHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function probe(instance: InstanceMetadata, query: string): Promise<string> {
  return (await sql(instance, query)).trim();
}

async function sql(instance: InstanceMetadata, query: string): Promise<string> {
  const result = await runCommand(
    "docker",
    [
      "compose",
      "-f",
      join(instance.worktreePath, instance.composeFile),
      "-f",
      instance.overrideFile,
      "-p",
      instance.composeProject,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-tAc",
      query,
    ],
    { cwd: instance.worktreePath },
  );
  return result.stdout;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(command, args, { cwd, env });
  return result.stdout;
}

function composeFixture(): string {
  return `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: branchlift
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 2s
      retries: 40
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 2s
      retries: 40
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data
volumes:
  pgdata: {}
  redisdata: {}
`;
}

function configFixture(): string {
  return `version: 1
compose:
  file: compose.yaml
  statefulServices:
    - postgres
    - redis
snapshot:
  default: dev
  healthTimeoutSeconds: 120
  seed:
    - service: postgres
      command:
        - psql
        - -U
        - postgres
        - -c
        - CREATE TABLE branchlift_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO branchlift_probe VALUES (1, 'golden');
worktree:
  copyFiles: []
`;
}
