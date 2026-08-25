import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runCommand } from "../src/process.js";
import { makeTreeOwnerWritable, safeSlug } from "../src/paths.js";
import { volumeDirectoryName } from "../src/compose.js";
import { discoverRepo } from "../src/git.js";
import type { InstanceMetadata } from "../src/types.js";

const enabled = process.env.BRANCHLIFT_E2E === "1";

test("creates two isolated stateful stacks and resets one to golden state", { skip: !enabled, timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-e2e-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-e2e-state-"));
  const cli = resolve("dist/src/cli.js");
  const env = {
    ...process.env,
    BRANCHLIFT_HOME: stateHome,
    BRANCHLIFT_E2E_COMPOSE_TOKEN: "compose-scope-value",
    BRANCHLIFT_E2E_SANDBOX_TOKEN: "sandbox-only-value",
    BRANCHLIFT_E2E_SANDBOX_FILE: "{\n  \"scope\": \"sandbox\"\n}\n",
  };
  let orphanNetwork: string | undefined;
  let crashedSnapshotNetwork: string | undefined;
  let activeLockPath: string | undefined;
  const importSourceProject = `branchlift-import-source-${process.pid}`;

  try {
    await writeFile(join(root, "compose.yaml"), composeFixture());
    await writeFile(join(root, "compose.dev.yaml"), composeDevFixture());
    await writeFile(join(root, "branchlift.yaml"), configFixture());
    await run("git", ["init", "-b", "main"], root, env);
    await run("git", ["config", "user.email", "branchlift-test@example.invalid"], root, env);
    await run("git", ["config", "user.name", "BranchLift Test"], root, env);
    await run("git", ["add", "."], root, env);
    await run("git", ["commit", "-m", "fixture"], root, env);
    await run(process.execPath, [cli, "security", "trust"], root, env);

    await run(process.execPath, [cli, "snapshot", "dev"], root, env);
    if (process.getuid !== undefined) {
      const repo = await discoverRepo(root);
      const redisState = join(
        stateHome,
        "repos",
        repo.key,
        "snapshots",
        safeSlug("dev"),
        "volumes",
        volumeDirectoryName("redisdata"),
        "dump.rdb",
      );
      assert.equal((await stat(redisState)).uid, process.getuid(), "snapshot exports must be owned by the invoking user");
    }
    const snapshots = JSON.parse(
      await run(process.execPath, [cli, "snapshot", "list", "--json"], root, env),
    ) as Array<{ name: string; status: string }>;
    assert.deepEqual(snapshots.map(({ name, status }) => ({ name, status })), [{ name: "dev", status: "ready" }]);

    const sourceCompose = [
      "compose",
      "-f",
      join(root, "compose.yaml"),
      "-f",
      join(root, "compose.dev.yaml"),
      "-p",
      importSourceProject,
    ];
    await run("docker", [...sourceCompose, "up", "-d", "--wait", "--wait-timeout", "120"], root, env);
    await run(
      "docker",
      [...sourceCompose, "exec", "-T", "postgres", "psql", "-U", "postgres", "-c", "CREATE TABLE imported_probe (value text NOT NULL); INSERT INTO imported_probe VALUES ('source-state');"],
      root,
      env,
    );
    const imported = JSON.parse(
      await run(process.execPath, [cli, "snapshot", "import", "source-copy", "--project", importSourceProject, "--json"], root, env),
    ) as { status: string; importedFromProject?: string };
    assert.equal(imported.status, "ready");
    assert.equal(imported.importedFromProject, importSourceProject);
    const restartedServices = (await run("docker", [...sourceCompose, "ps", "--status", "running", "--services"], root, env))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(restartedServices.sort(), ["mysql", "postgres", "redis"]);
    await run("docker", [...sourceCompose, "down", "--remove-orphans"], root, env);

    const importedInstance = JSON.parse(
      await run(process.execPath, [cli, "spawn", "import-check", "--snapshot", "source-copy", "--json"], root, env),
    ) as InstanceMetadata;
    assert.equal(await probe(importedInstance, "SELECT value FROM imported_probe"), "source-state");
    await run(process.execPath, [cli, "destroy", "import-check", "--worktree"], root, env);

    const attached = JSON.parse(
      await run(process.execPath, [cli, "attach", "--json"], root, env),
    ) as InstanceMetadata;
    assert.equal(attached.branch, "main");
    assert.equal(attached.worktreeOwner, "external");
    assert.equal(await realpath(attached.worktreePath), await realpath(root));
    assert.equal(await probe(attached, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    assert.equal(await mysqlProbe(attached, "SELECT value FROM branchlift_mysql_probe WHERE id = 1"), "golden");
    const hook = JSON.parse(
      await run(process.execPath, [cli, "hook", "attach", "--format", "claude"], root, env),
    ) as { hookSpecificOutput: { additionalContext: string } };
    assert.match(hook.hookSpecificOutput.additionalContext, /backend reused for main/);
    assert.equal((JSON.parse(await run(process.execPath, [cli, "list", "--json"], root, env)) as InstanceMetadata[]).length, 1);
    const preview = JSON.parse(
      await run(process.execPath, [cli, "preview", "main", "--json"], root, env),
    ) as Array<{ branch: string; endpoints: unknown[]; services?: Array<{ state: string }> }>;
    assert.equal(preview[0]?.branch, "main");
    assert.ok((preview[0]?.endpoints.length ?? 0) >= 3);
    assert.ok(preview[0]?.services?.some(({ state }) => state === "running"));
    assert.notEqual((await run(process.execPath, [cli, "logs", "main", "--service", "postgres", "--tail", "20"], root, env)).trim(), "");
    const removeAttachedWorktree = await runCommand(
      process.execPath,
      [cli, "destroy", "main", "--worktree"],
      { cwd: root, env, allowFailure: true },
    );
    assert.equal(removeAttachedWorktree.exitCode, 1);
    assert.match(removeAttachedWorktree.stderr, /externally owned worktree/);
    assert.equal(await probe(attached, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    assert.equal(await mysqlProbe(attached, "SELECT value FROM branchlift_mysql_probe WHERE id = 1"), "golden");
    await run(process.execPath, [cli, "destroy", "main"], root, env);
    assert.match(await readFile(join(root, "compose.yaml"), "utf8"), /postgres/);

    const first = JSON.parse(await run(process.execPath, [cli, "spawn", "agent-a", "--json"], root, env)) as InstanceMetadata;
    assert.ok(first.volumeRoot);
    assert.equal(await probe(first, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    assert.equal(await mysqlProbe(first, "SELECT value FROM branchlift_mysql_probe WHERE id = 1"), "golden");
    assert.equal(await serviceEnvironment(first, "redis", "E2E_COMPOSE_TOKEN"), "compose-scope-value");

    await run(
      process.execPath,
      [
        cli,
        "sandbox",
        "run",
        "agent-a",
        "--image",
        "alpine:3.22",
        "--network",
        "none",
        "--read-only-worktree",
        "--",
        "sh",
        "-ec",
        [
          'test "$BRANCHLIFT_SANDBOX" = "1"',
          'test "$BRANCHLIFT_E2E_SANDBOX_TOKEN" = "sandbox-only-value"',
          'test "$(cat /run/secrets/e2e.json)" = "{\n  \\"scope\\": \\"sandbox\\"\n}"',
          'test ! -e /var/run/docker.sock',
          'test "$(awk \'/CapEff/ { print $2 }\' /proc/self/status)" = "0000000000000000"',
          'test -z "$(awk \'NR > 1 && $2 == "00000000" { print $0 }\' /proc/net/route)"',
          'if touch /workspace/.branchlift-sandbox-write 2>/dev/null; then exit 41; fi',
          'if touch /etc/.branchlift-sandbox-write 2>/dev/null; then exit 42; fi',
        ].join("\n"),
      ],
      root,
      env,
    );
    await assert.rejects(stat(join(first.worktreePath, ".branchlift-sandbox-write")), /ENOENT/);

    await run(
      process.execPath,
      [
        cli,
        "exec",
        "agent-a",
        "--",
        process.execPath,
        "-e",
        "const fs = require('node:fs'); if (!process.env.BRANCHLIFT_POSTGRES_5432_PORT || fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.BRANCHLIFT_WORKTREE)) process.exit(3)",
      ],
      root,
      env,
    );
    const failedExec = await runCommand(
      process.execPath,
      [cli, "exec", "agent-a", "--", process.execPath, "-e", "process.exit(7)"],
      { cwd: root, env, allowFailure: true },
    );
    assert.equal(failedExec.exitCode, 7);

    activeLockPath = join(
      stateHome,
      "repos",
      first.repoKey,
      "locks",
      `${safeSlug("instance:agent-a")}.lock`,
    );
    await mkdir(dirname(activeLockPath), { recursive: true });
    await writeFile(activeLockPath, `${JSON.stringify({
      version: 1,
      token: "active-e2e-lock",
      scope: "instance:agent-a",
      operation: "concurrent reset",
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    })}\n`);
    const lockedReset = await runCommand(process.execPath, [cli, "reset", "agent-a"], {
      cwd: root,
      env,
      allowFailure: true,
    });
    assert.equal(lockedReset.exitCode, 1);
    assert.match(lockedReset.stderr, /Another BranchLift operation owns instance:agent-a/);
    assert.equal(await probe(first, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    await unlink(activeLockPath);
    activeLockPath = undefined;

    await sql(first, "UPDATE branchlift_probe SET value = 'changed' WHERE id = 1");
    await mysqlSql(first, "UPDATE branchlift_mysql_probe SET value = 'changed' WHERE id = 1");
    assert.equal(await probe(first, "SELECT value FROM branchlift_probe WHERE id = 1"), "changed");
    assert.equal(await mysqlProbe(first, "SELECT value FROM branchlift_mysql_probe WHERE id = 1"), "changed");

    const second = JSON.parse(await run(process.execPath, [cli, "spawn", "agent-b", "--json"], root, env)) as InstanceMetadata;
    assert.equal(await probe(second, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    assert.equal(await mysqlProbe(second, "SELECT value FROM branchlift_mysql_probe WHERE id = 1"), "golden");
    assert.notEqual(first.ports.find((port) => port.service === "postgres")?.port, second.ports.find((port) => port.service === "postgres")?.port);
    assert.notEqual(first.ports.find((port) => port.service === "mysql")?.port, second.ports.find((port) => port.service === "mysql")?.port);

    const deleteUsedSnapshot = await runCommand(process.execPath, [cli, "snapshot", "delete", "dev"], {
      cwd: root,
      env,
      allowFailure: true,
    });
    assert.equal(deleteUsedSnapshot.exitCode, 1);
    assert.match(deleteUsedSnapshot.stderr, /still used by 2 instance/);

    const projectPrefix = first.composeProject.slice(0, first.composeProject.indexOf("instance-"));
    const snapshotParent = join(stateHome, "repos", first.repoKey, "snapshots");
    const crashedSnapshotPath = join(snapshotParent, ".building-crashed-e2e");
    const crashedSnapshotProject = `${projectPrefix}snapshot-crashed-e2e`;
    crashedSnapshotNetwork = `${crashedSnapshotProject}-network`;
    await mkdir(join(crashedSnapshotPath, "volumes"), { recursive: true });
    await writeFile(join(crashedSnapshotPath, "metadata.json"), `${JSON.stringify({
      version: 1,
      name: "crashed-e2e",
      repoKey: first.repoKey,
      sourceRoot: root,
      composeFile: "compose.yaml",
      composeFiles: ["compose.yaml", "compose.dev.yaml"],
      composeProject: crashedSnapshotProject,
      createdAt: new Date().toISOString(),
      status: "building",
      volumeNames: ["pgdata", "redisdata"],
    })}\n`);
    await run(
      "docker",
      ["network", "create", "--label", `com.docker.compose.project=${crashedSnapshotProject}`, crashedSnapshotNetwork],
      root,
      env,
    );

    const orphanProject = `${projectPrefix}orphan-e2e`;
    orphanNetwork = `${orphanProject}-network`;
    await run("docker", ["network", "create", "--label", `com.docker.compose.project=${orphanProject}`, orphanNetwork], root, env);
    const doctor = JSON.parse(
      await run(process.execPath, [cli, "doctor", "--fix", "--json"], root, env),
    ) as { fixes: string[]; report: { findings: Array<{ code: string }> } };
    assert.ok(doctor.fixes.some((message) => message.includes(orphanProject)));
    assert.ok(doctor.fixes.some((message) => message.includes("Recovered abandoned snapshot build")));
    assert.ok(!doctor.report.findings.some(({ code }) => code === "orphan-runtime"));
    assert.ok(!doctor.report.findings.some(({ code }) => code === "abandoned-snapshot-build"));
    const orphanAfterFix = await runCommand("docker", ["network", "inspect", orphanNetwork], { allowFailure: true });
    assert.notEqual(orphanAfterFix.exitCode, 0);
    const crashedNetworkAfterFix = await runCommand("docker", ["network", "inspect", crashedSnapshotNetwork], {
      allowFailure: true,
    });
    assert.notEqual(crashedNetworkAfterFix.exitCode, 0);
    const recoveredDirectory = (await readdir(snapshotParent)).find((entry) => entry.startsWith(".failed-recovered-crashed-e2e-"));
    assert.ok(recoveredDirectory);
    const recoveredMetadata = JSON.parse(
      await readFile(join(snapshotParent, recoveredDirectory, "metadata.json"), "utf8"),
    ) as { status: string; error?: string };
    assert.equal(recoveredMetadata.status, "failed");
    assert.match(recoveredMetadata.error ?? "", /lost its owner/);

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
    assert.ok(resetFirst.volumeRoot);
    assert.notEqual(resetFirst.volumeRoot, first.volumeRoot);
    assert.notEqual(resetFirst.overrideFile, first.overrideFile);
    await assert.rejects(readdir(first.volumeRoot), /ENOENT/);
    await assert.rejects(readFile(first.overrideFile, "utf8"), /ENOENT/);
    assert.equal(await probe(resetFirst, "SELECT value FROM branchlift_probe WHERE id = 1"), "golden");
    assert.equal(await mysqlProbe(resetFirst, "SELECT value FROM branchlift_mysql_probe WHERE id = 1"), "golden");

    await run(process.execPath, [cli, "destroy", "agent-a", "--worktree"], root, env);
    await run(process.execPath, [cli, "destroy", "agent-b", "--worktree"], root, env);
  } finally {
    if (activeLockPath !== undefined) await unlink(activeLockPath).catch(() => undefined);
    if (orphanNetwork !== undefined) {
      await runCommand("docker", ["network", "rm", orphanNetwork], { allowFailure: true });
    }
    if (crashedSnapshotNetwork !== undefined) {
      await runCommand("docker", ["network", "rm", crashedSnapshotNetwork], { allowFailure: true });
    }
    await runCommand(
      "docker",
      ["compose", "-f", join(root, "compose.yaml"), "-f", join(root, "compose.dev.yaml"), "-p", importSourceProject, "down", "--remove-orphans"],
      { cwd: root, env, allowFailure: true },
    );
    const listed = await runCommand(process.execPath, [cli, "list", "--json"], { cwd: root, env, allowFailure: true });
    if (listed.exitCode === 0) {
      try {
        const instances = JSON.parse(listed.stdout) as InstanceMetadata[];
        for (const instance of instances) {
          const destroyArgs = [cli, "destroy", instance.branch];
          if (instance.worktreeOwner !== "external") destroyArgs.push("--worktree");
          await runCommand(process.execPath, destroyArgs, {
            cwd: root,
            env,
            allowFailure: true,
          });
        }
      } catch {
        // Product assertions report the original failure; cleanup remains best-effort.
      }
    }
    await makeTreeOwnerWritable(stateHome).catch(() => undefined);
    await rm(stateHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function probe(instance: InstanceMetadata, query: string): Promise<string> {
  return (await sql(instance, query)).trim();
}

async function sql(instance: InstanceMetadata, query: string): Promise<string> {
  const composeFiles = (instance.composeFiles ?? [instance.composeFile]).flatMap((file) => ["-f", join(instance.worktreePath, file)]);
  const result = await runCommand(
    "docker",
    [
      "compose",
      ...composeFiles,
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

async function mysqlProbe(instance: InstanceMetadata, query: string): Promise<string> {
  return (await mysqlSql(instance, query)).trim();
}

async function mysqlSql(instance: InstanceMetadata, query: string): Promise<string> {
  const composeFiles = (instance.composeFiles ?? [instance.composeFile]).flatMap((file) => ["-f", join(instance.worktreePath, file)]);
  const result = await runCommand(
    "docker",
    [
      "compose",
      ...composeFiles,
      "-f",
      instance.overrideFile,
      "-p",
      instance.composeProject,
      "exec",
      "-T",
      "mysql",
      "mysql",
      "-uroot",
      "-pbranchlift",
      "--database=branchlift",
      "--batch",
      "--skip-column-names",
      "--execute",
      query,
    ],
    { cwd: instance.worktreePath },
  );
  return result.stdout;
}

async function serviceEnvironment(instance: InstanceMetadata, service: string, name: string): Promise<string> {
  const composeFiles = (instance.composeFiles ?? [instance.composeFile]).flatMap((file) => ["-f", join(instance.worktreePath, file)]);
  const result = await runCommand("docker", [
    "compose",
    ...composeFiles,
    "-f",
    instance.overrideFile,
    "-p",
    instance.composeProject,
    "exec",
    "-T",
    service,
    "sh",
    "-c",
    `printf %s \"\$${name}\"`,
  ], { cwd: instance.worktreePath });
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
    volumes:
      - pgdata:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    environment:
      E2E_COMPOSE_TOKEN: \${E2E_COMPOSE_TOKEN:-missing}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      timeout: 2s
      retries: 40
    volumes:
      - redisdata:/data
  mysql:
    image: mysql:8.4
    command: ["--lower-case-table-names=1"]
    environment:
      MYSQL_ROOT_PASSWORD: branchlift
      MYSQL_DATABASE: branchlift
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -pbranchlift --silent"]
      interval: 1s
      timeout: 3s
      retries: 60
    volumes:
      - mysqldata:/var/lib/mysql
volumes:
  pgdata: {}
  redisdata: {}
  mysqldata: {}
`;
}

function composeDevFixture(): string {
  return `services:
  postgres:
    ports:
      - "5432:5432"
  redis:
    ports:
      - "6379:6379"
  mysql:
    ports:
      - "3306:3306"
`;
}

function configFixture(): string {
  return `version: 1
compose:
  files:
    - compose.yaml
    - compose.dev.yaml
  statefulServices:
    - postgres
    - redis
    - mysql
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
    - service: mysql
      command:
        - mysql
        - -uroot
        - -pbranchlift
        - --database=branchlift
        - --execute
        - CREATE TABLE branchlift_mysql_probe (id integer PRIMARY KEY, value varchar(32) NOT NULL); INSERT INTO branchlift_mysql_probe VALUES (1, 'golden');
worktree:
  copyFiles: []
security:
  sandbox:
    backend: docker
    image: alpine:3.22
    network: none
    readOnlyRoot: true
    memory: 512m
    cpus: 1
    pidsLimit: 128
  allowHostAgentCommands: false
  allowSecretCommands: false
secrets:
  e2eCompose:
    source:
      env: BRANCHLIFT_E2E_COMPOSE_TOKEN
    target:
      env: E2E_COMPOSE_TOKEN
    scopes: [compose]
    required: true
  e2eSandbox:
    source:
      env: BRANCHLIFT_E2E_SANDBOX_TOKEN
    target:
      env: BRANCHLIFT_E2E_SANDBOX_TOKEN
    scopes: [sandbox]
    required: true
  e2eSandboxFile:
    source:
      env: BRANCHLIFT_E2E_SANDBOX_FILE
    target:
      file: /run/secrets/e2e.json
    scopes: [sandbox]
    required: true
`;
}
