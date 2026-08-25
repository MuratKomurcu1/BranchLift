import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { makeTreeOwnerWritable } from "../src/paths.js";
import { runCommand } from "../src/process.js";
import type { InstanceMetadata } from "../src/types.js";

const enabled = process.env.BRANCHLIFT_MONGO_KAFKA_E2E === "1";

test("branches, resets, and commits real MongoDB plus Kafka state", { skip: !enabled, timeout: 480_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-mongo-kafka-e2e-"));
  const stateHome = await mkdtemp(join(tmpdir(), "branchlift-mongo-kafka-state-"));
  const cli = resolve("dist/src/cli.js");
  const env = { ...process.env, BRANCHLIFT_HOME: stateHome };
  try {
    await writeFile(join(root, "compose.yaml"), await readFile(resolve("examples/mongo-kafka/compose.yaml"), "utf8"));
    await writeFile(join(root, "branchlift.yaml"), await readFile(resolve("examples/mongo-kafka/branchlift.yaml"), "utf8"));
    await run("git", ["init", "-b", "main"], root, env);
    await run("git", ["config", "user.email", "branchlift-test@example.invalid"], root, env);
    await run("git", ["config", "user.name", "BranchLift Test"], root, env);
    await run("git", ["add", "."], root, env);
    await run("git", ["commit", "-m", "fixture"], root, env);
    await run(process.execPath, [cli, "security", "trust"], root, env);
    await run(process.execPath, [cli, "snapshot", "dev"], root, env);

    const original = JSON.parse(
      await run(process.execPath, [cli, "spawn", "agent/mongo-kafka", "--json"], root, env),
    ) as InstanceMetadata;
    assert.equal(await mongoValue(original), "golden");
    assert.deepEqual(await kafkaValues(original, 1), ["golden"]);
    if (process.platform === "darwin") assert.ok(original.nativeVolumes?.mongo_data);
    else assert.equal(original.nativeVolumes, undefined);

    await composeExec(original, "mongodb", [
      "mongosh",
      "--quiet",
      "--eval",
      "db.getSiblingDB('app').examples.updateOne({_id:1},{$set:{value:'mutated'}})",
    ]);
    await composeExec(original, "kafka", [
      "/bin/sh",
      "-ec",
      "printf 'mutated\\n' | /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic examples",
    ]);
    await run(process.execPath, [cli, "snapshot", "commit", "mutated", "--from", original.branch], root, env);

    await run(process.execPath, [cli, "reset", original.branch], root, env);
    const reset = await instanceByBranch(cli, root, env, original.branch);
    assert.equal(await mongoValue(reset), "golden");

    const committed = JSON.parse(
      await run(process.execPath, [cli, "spawn", "agent/committed", "--snapshot", "mutated", "--json"], root, env),
    ) as InstanceMetadata;
    assert.equal(await mongoValue(committed), "mutated");
    assert.deepEqual(await kafkaValues(committed, 2), ["golden", "mutated"]);
  } finally {
    const listed = await runCommand(process.execPath, [cli, "list", "--json"], {
      cwd: root,
      env,
      allowFailure: true,
    });
    if (listed.exitCode === 0) {
      try {
        for (const instance of JSON.parse(listed.stdout) as InstanceMetadata[]) {
          const args = [cli, "destroy", instance.branch];
          if (instance.worktreeOwner !== "external") args.push("--worktree");
          await runCommand(process.execPath, args, { cwd: root, env, allowFailure: true });
        }
      } catch {
        // Keep the product assertion as the primary failure; cleanup is best-effort.
      }
    }
    await makeTreeOwnerWritable(stateHome).catch(() => undefined);
    await rm(stateHome, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function instanceByBranch(
  cli: string,
  root: string,
  env: NodeJS.ProcessEnv,
  branch: string,
): Promise<InstanceMetadata> {
  const instances = JSON.parse(await run(process.execPath, [cli, "list", "--json"], root, env)) as InstanceMetadata[];
  const instance = instances.find((entry) => entry.branch === branch);
  assert.ok(instance);
  return instance;
}

async function mongoValue(instance: InstanceMetadata): Promise<string> {
  return (await composeExec(instance, "mongodb", [
    "mongosh",
    "--quiet",
    "--eval",
    "db.getSiblingDB('app').examples.findOne({_id:1}).value",
  ])).trim();
}

async function kafkaValues(instance: InstanceMetadata, count: number): Promise<string[]> {
  const output = await composeExec(instance, "kafka", [
    "/opt/kafka/bin/kafka-console-consumer.sh",
    "--bootstrap-server",
    "localhost:9092",
    "--topic",
    "examples",
    "--from-beginning",
    "--max-messages",
    String(count),
    "--timeout-ms",
    "10000",
  ]);
  return output.trim().split("\n").filter(Boolean);
}

async function composeExec(instance: InstanceMetadata, service: string, command: string[]): Promise<string> {
  const files = (instance.composeFiles ?? [instance.composeFile])
    .flatMap((file) => ["-f", join(instance.worktreePath, file)]);
  return (await runCommand("docker", [
    "compose",
    ...files,
    "-f",
    instance.overrideFile,
    "-p",
    instance.composeProject,
    "exec",
    "-T",
    service,
    ...command,
  ], { cwd: instance.worktreePath })).stdout;
}

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await runCommand(command, args, { cwd, env })).stdout;
}
