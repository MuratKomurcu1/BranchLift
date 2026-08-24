#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { benchmarkSnapshot } from "./benchmark.js";
import { initializeConfig, inspectConfiguredCompose, loadConfig } from "./config.js";
import { assertDockerReady } from "./docker.js";
import { BranchLiftError } from "./errors.js";
import { discoverRepo } from "./git.js";
import { humanBytes, safeSlug } from "./paths.js";
import {
  destroyInstance,
  resetInstance,
  spawnInstance,
  startInstance,
  stopInstance,
} from "./runtime.js";
import { createSnapshot } from "./snapshot.js";
import { listInstances } from "./state.js";
import type { ComposeInspection, InstanceMetadata } from "./types.js";

const version = "0.1.0";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(version);
    return 0;
  }

  try {
    const repo = await discoverRepo();
    switch (command) {
      case "init": {
        const compose = takeOption(args, "--compose");
        assertNoArgs(args);
        const result = await initializeConfig(repo, compose);
        console.log(`Created ${relative(repo.root, result.path)}.`);
        printInspection(result.inspection);
        if (result.inspection.blockers.length > 0) {
          console.log("\nFix the blockers above before creating a snapshot.");
        } else {
          console.log(`\nNext: branchlift snapshot ${result.config.snapshot.default}`);
        }
        return 0;
      }
      case "inspect": {
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        if (json) console.log(JSON.stringify(inspection, null, 2));
        else printInspection(inspection);
        return inspection.blockers.length === 0 ? 0 : 2;
      }
      case "snapshot": {
        const json = takeFlag(args, "--json");
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        const name = args.shift() ?? config.snapshot.default;
        assertNoArgs(args);
        if (!json) console.log(`Building immutable snapshot ${name}...`);
        const result = await createSnapshot(repo, config, inspection, name);
        if (json) console.log(JSON.stringify(result.metadata, null, 2));
        else {
          console.log(`Snapshot ${name} is ready.`);
          console.log(`State: ${result.path}`);
          console.log(`Logical size: ${humanBytes(result.metadata.sizeBytes ?? 0)}`);
        }
        return 0;
      }
      case "spawn": {
        const separator = args.indexOf("--");
        const agentCommand = separator >= 0 ? args.splice(separator + 1) : [];
        if (separator >= 0) args.splice(separator, 1);
        const snapshotOption = takeOption(args, "--snapshot");
        const noStart = takeFlag(args, "--no-start");
        const json = takeFlag(args, "--json");
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        if (!json) console.log(`Forking ${snapshotOption ?? config.snapshot.default} into ${branch}...`);
        const instance = await spawnInstance(repo, config, inspection, branch, {
          snapshot: snapshotOption ?? config.snapshot.default,
          start: !noStart,
          agentCommand,
        });
        if (json) console.log(JSON.stringify(instance, null, 2));
        else printInstance(instance);
        return 0;
      }
      case "start": {
        const separator = args.indexOf("--");
        const agentCommand = separator >= 0 ? args.splice(separator + 1) : [];
        if (separator >= 0) args.splice(separator, 1);
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        const instance = await startInstance(repo, config, inspection, branch, { agentCommand });
        printInstance(instance);
        return 0;
      }
      case "stop": {
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        const instance = await stopInstance(repo, branch);
        console.log(`Stopped ${instance.branch}; state is preserved.`);
        return 0;
      }
      case "reset": {
        const noStart = takeFlag(args, "--no-start");
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        const instance = await resetInstance(repo, config, inspection, branch, !noStart);
        console.log(`Reset ${branch} from snapshot ${instance.snapshot}.`);
        printInstance(instance);
        return 0;
      }
      case "destroy": {
        const removeWorktree = takeFlag(args, "--worktree");
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        const result = await destroyInstance(repo, branch, removeWorktree);
        console.log(`Removed runtime state for ${branch}.`);
        if (result.worktreeRemoved) console.log("Removed its clean Git worktree; the branch was preserved.");
        else console.log("Git worktree and branch were preserved.");
        return 0;
      }
      case "list": {
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const instances = await listInstances(repo);
        if (json) console.log(JSON.stringify(instances, null, 2));
        else printInstances(instances);
        return 0;
      }
      case "doctor": {
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        let dockerReady = true;
        try {
          await assertDockerReady();
        } catch {
          dockerReady = false;
        }
        console.log(`Git repository: ok (${repo.root})`);
        console.log(`Compose analysis: ${inspection.blockers.length === 0 ? "ok" : `${inspection.blockers.length} blocker(s)`}`);
        console.log(`Docker daemon: ${dockerReady ? "ok" : "unavailable"}`);
        if (inspection.warnings.length > 0) inspection.warnings.forEach((warning) => console.log(`warning: ${warning}`));
        if (inspection.blockers.length > 0) inspection.blockers.forEach((blocker) => console.log(`blocker: ${blocker}`));
        return dockerReady && inspection.blockers.length === 0 ? 0 : 2;
      }
      case "benchmark": {
        const json = takeFlag(args, "--json");
        const iterationsValue = takeOption(args, "--iterations");
        const config = await loadConfig(repo);
        const name = args.shift() ?? config.snapshot.default;
        assertNoArgs(args);
        const iterations = iterationsValue === undefined ? 5 : Number.parseInt(iterationsValue, 10);
        if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
          throw new BranchLiftError("--iterations must be an integer between 1 and 100.");
        }
        const result = await benchmarkSnapshot(repo, name, iterations);
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`Snapshot: ${result.snapshot} (${humanBytes(result.logicalBytes)} logical)`);
          console.log(`Copy strategy: ${result.strategy}`);
          console.log(`Median: ${result.medianMs} ms`);
          console.log(`p95: ${result.p95Ms} ms (${result.iterations} iterations)`);
        }
        return 0;
      }
      default:
        throw new BranchLiftError(`Unknown command: ${command}`, "Run branchlift help to see available commands.");
    }
  } catch (error) {
    printError(error);
    return 1;
  }
}

function printInspection(inspection: ComposeInspection): void {
  console.log(`Compose: ${inspection.file}`);
  console.log(`Services: ${inspection.services.join(", ")}`);
  console.log(
    `Stateful: ${inspection.inferredStatefulServices.length > 0 ? inspection.inferredStatefulServices.join(", ") : "none"}`,
  );
  console.log(
    `Cloneable volumes: ${
      inspection.volumes.length > 0
        ? [...new Set(inspection.volumes.map((volume) => volume.source))].join(", ")
        : "none"
    }`,
  );
  console.log(`Published ports: ${inspection.ports.length}`);
  inspection.warnings.forEach((warning) => console.log(`warning: ${warning}`));
  inspection.blockers.forEach((blocker) => console.log(`blocker: ${blocker}`));
  if (inspection.warnings.length === 0 && inspection.blockers.length === 0) console.log("Isolation check: clean");
}

function printInstance(instance: InstanceMetadata): void {
  console.log(`Instance ${instance.branch}: ${instance.status}`);
  console.log(`Worktree: ${instance.worktreePath}`);
  console.log(`Snapshot: ${instance.snapshot}`);
  console.log(`State copy: ${instance.copyStrategy}`);
  if (instance.ports.length === 0) {
    console.log("Ports: none published");
  } else {
    for (const port of instance.ports) {
      console.log(`Port: ${port.service} ${port.target}/${port.protocol} -> ${port.host}:${port.port}`);
    }
  }
}

function printInstances(instances: InstanceMetadata[]): void {
  if (instances.length === 0) {
    console.log("No BranchLift instances for this repository.");
    return;
  }
  console.log("STATUS\tBRANCH\tSNAPSHOT\tPORTS\tWORKTREE");
  for (const instance of instances) {
    const ports = instance.ports.map((port) => `${port.service}:${port.port}`).join(",") || "-";
    console.log(`${instance.status}\t${instance.branch}\t${instance.snapshot}\t${ports}\t${instance.worktreePath}`);
  }
}

function printError(error: unknown): void {
  if (error instanceof BranchLiftError) {
    console.error(`error: ${error.message}`);
    if (error.hint) console.error(error.hint);
    return;
  }
  if (error instanceof Error) {
    console.error(`error: ${error.message}`);
    if (process.env.BRANCHLIFT_DEBUG === "1" && error.stack) console.error(error.stack);
    return;
  }
  console.error(`error: ${String(error)}`);
}

function requirePositional(args: string[], name: string): string {
  const value = args.shift();
  if (value === undefined || value.startsWith("-")) throw new BranchLiftError(`Missing required argument: ${name}`);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new BranchLiftError(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new BranchLiftError(`Unexpected argument: ${args[0]}`);
}

function printHelp(): void {
  console.log(`BranchLift ${version} — stateful backend environments for parallel coding agents

Usage:
  branchlift init [--compose FILE]
  branchlift inspect [--json]
  branchlift snapshot [NAME]
  branchlift spawn BRANCH [--snapshot NAME] [--no-start] [-- AGENT ...]
  branchlift start BRANCH [-- AGENT ...]
  branchlift stop BRANCH
  branchlift reset BRANCH [--no-start]
  branchlift list [--json]
  branchlift destroy BRANCH [--worktree]
  branchlift doctor
  branchlift benchmark [SNAPSHOT] [--iterations N]

Examples:
  branchlift snapshot dev
  branchlift spawn fix-auth -- codex
  branchlift spawn billing -- claude
  branchlift reset fix-auth

Snapshots are immutable. destroy removes BranchLift runtime state but preserves the Git
worktree and branch unless --worktree is explicitly provided.`);
}

const entry = process.argv[1];
if (entry !== undefined) {
  const resolvedEntry = await realpath(entry).catch(() => entry);
  if (import.meta.url === pathToFileURL(resolvedEntry).href) process.exitCode = await main();
}
