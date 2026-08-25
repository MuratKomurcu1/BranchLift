#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { displayInstallPath, installAgentIntegrations, parseAgentName } from "./agents.js";
import { benchmarkSnapshot } from "./benchmark.js";
import { initializeConfig, inspectConfiguredCompose, loadConfig } from "./config.js";
import { assertDockerReady } from "./docker.js";
import { applyDoctorFixes, auditState, inspectDockerProjects } from "./doctor.js";
import { BranchLiftError } from "./errors.js";
import { currentBranch, discoverRepo } from "./git.js";
import { runMcpServer } from "./mcp.js";
import { humanBytes, safeSlug } from "./paths.js";
import { previewInstances, readInstanceLogs } from "./preview.js";
import {
  attachInstance,
  destroyInstance,
  ensureAttachedInstance,
  execInInstance,
  instanceContext,
  resetInstance,
  spawnInstance,
  startInstance,
  stopInstance,
} from "./runtime.js";
import { createSnapshot } from "./snapshot.js";
import { deleteSnapshot, listInstances, listSnapshots } from "./state.js";
import type { ComposeInspection, InstanceMetadata } from "./types.js";
import { version } from "./version.js";

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
      case "mcp": {
        assertNoArgs(args);
        await runMcpServer(repo);
        return 0;
      }
      case "agents": {
        const action = args.shift();
        if (action !== "install") throw new BranchLiftError("Usage: branchlift agents install [all|codex|claude|cursor]");
        const dryRun = takeFlag(args, "--dry-run");
        const json = takeFlag(args, "--json");
        const selected = parseAgentName(args.shift() ?? "all");
        assertNoArgs(args);
        const results = await installAgentIntegrations(repo, selected, !dryRun);
        if (json) console.log(JSON.stringify({ dryRun, results }, null, 2));
        else {
          for (const result of results) {
            const verb = result.changed ? (dryRun ? "would update" : "updated") : "already configured";
            console.log(`${result.agent} ${result.kind}: ${verb} ${displayInstallPath(repo, result.path)}`);
          }
          if (!dryRun) console.log("Agent hooks will attach or reuse the current branch backend on session start.");
        }
        return 0;
      }
      case "hook": {
        const action = args.shift();
        if (action !== "attach") throw new BranchLiftError("Usage: branchlift hook attach [--format claude|cursor]");
        const format = takeOption(args, "--format") ?? "claude";
        if (format !== "claude" && format !== "cursor") throw new BranchLiftError("--format must be claude or cursor.");
        assertNoArgs(args);
        let context: string;
        try {
          const config = await loadConfig(repo);
          const inspection = await inspectConfiguredCompose(repo, config);
          const branch = await currentBranch(repo);
          const ensured = await ensureAttachedInstance(repo, config, inspection, branch, {
            snapshot: config.snapshot.default,
            start: true,
            quiet: true,
          });
          context = `BranchLift backend ${ensured.action} for ${branch}. Context: ${JSON.stringify(instanceContext(ensured.instance))}`;
        } catch (error) {
          context = `BranchLift automatic attach skipped: ${errorText(error)}`;
        }
        if (format === "cursor") console.log(JSON.stringify({ additional_context: context }));
        else console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
        return 0;
      }
      case "init": {
        const composeFiles = takeOptions(args, "--compose");
        const dryRun = takeFlag(args, "--dry-run");
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const result = await initializeConfig(repo, composeFiles.length > 0 ? composeFiles : undefined, { write: !dryRun });
        if (json) {
          console.log(JSON.stringify({ written: result.written, path: result.path, config: result.config, inspection: result.inspection }, null, 2));
          return result.inspection.blockers.length === 0 ? 0 : 2;
        }
        console.log(dryRun ? `Would create ${relative(repo.root, result.path)}:` : `Created ${relative(repo.root, result.path)}.`);
        if (dryRun) console.log(`\n${JSON.stringify(result.config, null, 2)}\n`);
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
        const action = args[0];
        if (action === "list") {
          args.shift();
          const json = takeFlag(args, "--json");
          assertNoArgs(args);
          const snapshots = await listSnapshots(repo);
          if (json) console.log(JSON.stringify(snapshots, null, 2));
          else printSnapshots(snapshots);
          return 0;
        }
        if (action === "delete") {
          args.shift();
          const name = requirePositional(args, "snapshot name");
          assertNoArgs(args);
          await deleteSnapshot(repo, name);
          console.log(`Deleted immutable snapshot ${name}.`);
          return 0;
        }
        if (action === "create") args.shift();
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
          quiet: json,
        });
        if (json) console.log(JSON.stringify(instance, null, 2));
        else printInstance(instance);
        return 0;
      }
      case "attach": {
        const separator = args.indexOf("--");
        const agentCommand = separator >= 0 ? args.splice(separator + 1) : [];
        if (separator >= 0) args.splice(separator, 1);
        const snapshotOption = takeOption(args, "--snapshot");
        const noStart = takeFlag(args, "--no-start");
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        const branch = await currentBranch(repo);
        if (!json) console.log(`Attaching ${snapshotOption ?? config.snapshot.default} to ${branch}...`);
        const instance = await attachInstance(repo, config, inspection, branch, {
          snapshot: snapshotOption ?? config.snapshot.default,
          start: !noStart,
          agentCommand,
          quiet: json,
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
      case "exec": {
        const separator = args.indexOf("--");
        if (separator < 0) throw new BranchLiftError("branchlift exec requires -- before the command.");
        const childCommand = args.splice(separator + 1);
        args.splice(separator, 1);
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        if (childCommand.length === 0) throw new BranchLiftError("Missing command after --.");
        return await execInInstance(repo, branch, childCommand);
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
      case "preview": {
        const json = takeFlag(args, "--json");
        const branch = args.shift();
        assertNoArgs(args);
        const previews = await previewInstances(repo, branch);
        if (json) console.log(JSON.stringify(previews, null, 2));
        else printPreviews(previews);
        return 0;
      }
      case "logs": {
        const service = takeOption(args, "--service");
        const tailValue = takeOption(args, "--tail");
        const follow = takeFlag(args, "--follow");
        const timestamps = takeFlag(args, "--timestamps");
        const branch = args.shift() ?? await currentBranch(repo);
        assertNoArgs(args);
        const tail = tailValue === undefined ? 200 : Number.parseInt(tailValue, 10);
        if (!Number.isInteger(tail) || tail < 1 || tail > 10000) {
          throw new BranchLiftError("--tail must be an integer between 1 and 10000.");
        }
        const output = await readInstanceLogs(repo, branch, { ...(service === undefined ? {} : { service }), tail, follow, timestamps });
        if (!follow && output !== "") console.log(output);
        return 0;
      }
      case "doctor": {
        const fix = takeFlag(args, "--fix");
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        const inspection = await inspectConfiguredCompose(repo, config);
        let dockerReady = true;
        try {
          await assertDockerReady();
        } catch {
          dockerReady = false;
        }
        const dockerProjects = dockerReady ? await inspectDockerProjects() : undefined;
        let report = await auditState(repo, dockerProjects);
        const fixes = fix ? await applyDoctorFixes(repo, report) : [];
        if (fix && fixes.length > 0) {
          report = await auditState(repo, dockerReady ? await inspectDockerProjects() : undefined);
        }
        if (json) {
          console.log(JSON.stringify({ dockerReady, inspection, report, fixes }, null, 2));
        } else {
          printDoctor(repo.root, dockerReady, inspection, report, fixes);
        }
        return dockerReady && inspection.blockers.length === 0 && !report.findings.some(({ severity }) => severity === "error")
          ? 0
          : 2;
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
          console.log(`Clone strategy: ${result.strategy}`);
          console.log(`Clone median: ${result.cloneMedianMs} ms`);
          console.log(`Clone p95: ${result.cloneP95Ms} ms (${result.iterations} iterations)`);
          console.log(`Full-copy median: ${result.fullCopyMedianMs} ms`);
          console.log(`Median speedup: ${result.speedup}x`);
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
  console.log(`Compose: ${inspection.files.join(", ")}`);
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
  inspection.recommendations.forEach((recommendation) => console.log(`recommendation: ${recommendation}`));
  if (inspection.warnings.length === 0 && inspection.blockers.length === 0) console.log("Isolation check: clean");
}

function printInstance(instance: InstanceMetadata): void {
  console.log(`Instance ${instance.branch}: ${instance.status}`);
  console.log(`Worktree: ${instance.worktreePath}`);
  console.log(`Worktree owner: ${instance.worktreeOwner ?? "branchlift"}`);
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
  console.log("STATUS\tOWNER\tBRANCH\tSNAPSHOT\tPORTS\tWORKTREE");
  for (const instance of instances) {
    const ports = instance.ports.map((port) => `${port.service}:${port.port}`).join(",") || "-";
    console.log(
      `${instance.status}\t${instance.worktreeOwner ?? "branchlift"}\t${instance.branch}\t${instance.snapshot}\t${ports}\t${instance.worktreePath}`,
    );
  }
}

function printPreviews(previews: Awaited<ReturnType<typeof previewInstances>>): void {
  if (previews.length === 0) {
    console.log("No BranchLift instances for this repository.");
    return;
  }
  for (const preview of previews) {
    const live = preview.services === undefined
      ? "Docker unavailable"
      : preview.services.length === 0
        ? "no containers"
        : preview.services.map((service) => `${service.service}:${service.state}${service.health ? `/${service.health}` : ""}`).join(", ");
    console.log(`${preview.branch} — ${preview.status} — ${live}`);
    if (preview.endpoints.length === 0) console.log("  no published endpoints");
    for (const endpoint of preview.endpoints) console.log(`  ${endpoint.service}:${endpoint.target} -> ${endpoint.url}`);
    console.log(`  worktree: ${preview.worktreePath}`);
  }
}

function printSnapshots(snapshots: Awaited<ReturnType<typeof listSnapshots>>): void {
  if (snapshots.length === 0) {
    console.log("No BranchLift snapshots for this repository.");
    return;
  }
  console.log("STATUS\tNAME\tLOGICAL SIZE\tCREATED");
  for (const snapshot of snapshots) {
    console.log(
      `${snapshot.status}\t${snapshot.name}\t${humanBytes(snapshot.sizeBytes ?? 0)}\t${snapshot.createdAt}`,
    );
  }
}

function printDoctor(
  root: string,
  dockerReady: boolean,
  inspection: ComposeInspection,
  report: Awaited<ReturnType<typeof auditState>>,
  fixes: string[],
): void {
  console.log(`Git repository: ok (${root})`);
  console.log(`Compose analysis: ${inspection.blockers.length === 0 ? "ok" : `${inspection.blockers.length} blocker(s)`}`);
  console.log(`Docker daemon: ${dockerReady ? "ok" : "unavailable"}`);
  console.log(
    `BranchLift state: ${report.snapshots} snapshot(s), ${report.instances} instance(s), ${report.activeLocks} active lock(s)`,
  );
  inspection.warnings.forEach((warning) => console.log(`warning: ${warning}`));
  inspection.blockers.forEach((blocker) => console.log(`blocker: ${blocker}`));
  inspection.recommendations.forEach((recommendation) => console.log(`recommendation: ${recommendation}`));
  report.findings.forEach((finding) => {
    console.log(`${finding.severity}: [${finding.code}] ${finding.message}${finding.fixable ? " (fixable)" : ""}`);
  });
  fixes.forEach((fix) => console.log(`fixed: ${fix}`));
  if (report.findings.length === 0 && inspection.blockers.length === 0 && dockerReady) {
    console.log("Runtime audit: clean");
  } else if (report.findings.some(({ fixable }) => fixable)) {
    console.log("Run branchlift doctor --fix to apply safe repairs.");
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

function errorText(error: unknown): string {
  if (error instanceof BranchLiftError) return [error.message, error.hint].filter(Boolean).join(" ");
  return error instanceof Error ? error.message : String(error);
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

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  let value: string | undefined;
  while ((value = takeOption(args, name)) !== undefined) values.push(value);
  return values;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new BranchLiftError(`Unexpected argument: ${args[0]}`);
}

function printHelp(): void {
  console.log(`BranchLift ${version} — stateful backend environments for parallel coding agents

Usage:
  branchlift init [--compose FILE]... [--dry-run] [--json]
  branchlift inspect [--json]
  branchlift snapshot [create] [NAME]
  branchlift snapshot list [--json]
  branchlift snapshot delete NAME
  branchlift spawn BRANCH [--snapshot NAME] [--no-start] [-- AGENT ...]
  branchlift attach [--snapshot NAME] [--no-start] [-- AGENT ...]
  branchlift start BRANCH [-- AGENT ...]
  branchlift stop BRANCH
  branchlift exec BRANCH -- COMMAND ...
  branchlift reset BRANCH [--no-start]
  branchlift list [--json]
  branchlift preview [BRANCH] [--json]
  branchlift logs [BRANCH] [--service NAME] [--tail N] [--follow] [--timestamps]
  branchlift destroy BRANCH [--worktree]
  branchlift doctor [--fix] [--json]
  branchlift benchmark [SNAPSHOT] [--iterations N]
  branchlift agents install [all|codex|claude|cursor] [--dry-run] [--json]
  branchlift mcp

Examples:
  branchlift snapshot dev
  branchlift spawn fix-auth -- codex
  branchlift spawn billing -- claude
  branchlift attach -- codex
  branchlift agents install all
  branchlift preview
  branchlift logs fix-auth --service api --tail 100
  branchlift reset fix-auth
  branchlift exec fix-auth -- npm test

Snapshots are immutable. destroy removes BranchLift runtime state but preserves the Git
worktree and branch unless --worktree is explicitly provided.`);
}

const entry = process.argv[1];
if (entry !== undefined) {
  const resolvedEntry = await realpath(entry).catch(() => entry);
  if (import.meta.url === pathToFileURL(resolvedEntry).href) process.exitCode = await main();
}
