#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { displayInstallPath, installAgentIntegrations, parseAgentName } from "./agents.js";
import { benchmarkSnapshot } from "./benchmark.js";
import { inspectHostPlatform } from "./container.js";
import { effectiveSecurity, initializeConfig, inspectConfiguredCompose, loadConfig } from "./config.js";
import { assertDockerReady } from "./docker.js";
import { applyDoctorFixes, auditState, inspectDockerProjects } from "./doctor.js";
import { BranchLiftError } from "./errors.js";
import { listEvents } from "./events.js";
import { currentBranch, discoverRepo } from "./git.js";
import { collectGarbage, parseAge } from "./gc.js";
import { diffSnapshots, ensureSnapshotManifest } from "./manifest.js";
import { runMcpServer } from "./mcp.js";
import { ensurePrivateStateRoot, humanBytes, safeSlug } from "./paths.js";
import { inspectPolicyTrust, revokeSecurityPolicy, securityPolicyDigest, trustSecurityPolicy } from "./policy.js";
import { previewInstances, readInstanceLogs } from "./preview.js";
import { addRemote, callRemote, listRemotes, removeRemote, runRemoteWorker, setupRemote } from "./remote.js";
import {
  pushRemoteSnapshot,
  runRemoteReceiver,
  syncRemoteCode,
  syncRemoteWorkingTree,
  watchRemoteWorkingTree,
} from "./remote-transfer.js";
import {
  inspectRemoteTunnel,
  monitorRemoteTunnels,
  runRemoteAgent,
  runRemoteBuild,
  runRemoteBuildWorker,
  runRemoteCache,
  runRemoteCacheWorker,
  runRemoteSession,
  startRemoteTunnels,
  stopRemoteTunnels,
} from "./remote-dev.js";
import { runSandbox, sandboxPosture } from "./sandbox.js";
import { inspectSecrets } from "./secrets.js";
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
import { commitSnapshotFromInstance, createSnapshot, importSnapshot } from "./snapshot.js";
import { deleteSnapshot, listInstances, listSnapshots } from "./state.js";
import { quickstartRepository, scaffoldDemoProject } from "./quickstart.js";
import { createTeamToken, listTeamRegistry, listTeamTokens, parseTeamRole, publishTeamRegistry, revokeTeamToken } from "./team.js";
import type { ComposeInspection, InstanceMetadata, RepoInfo, WorkspaceTask } from "./types.js";
import type { SandboxBackend, SandboxNetwork } from "./types.js";
import { runUiServer } from "./ui.js";
import { version } from "./version.js";
import { createWorkspaceTask, deleteWorkspaceTask, listWorkspaceTasks, moveWorkspaceTask, parseWorkspaceTaskStatus } from "./workspace.js";

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
  await ensurePrivateStateRoot();
  if (command === "worker") {
    if (args.length > 0) {
      console.error(`error: Unexpected argument: ${args[0]}`);
      return 1;
    }
    return await runRemoteWorker();
  }
  if (command === "receive") {
    if (args.length > 0) {
      console.error(`error: Unexpected argument: ${args[0]}`);
      return 1;
    }
    return await runRemoteReceiver();
  }
  if (command === "session" || command === "build" || command === "cache") {
    const encoded = args.shift();
    if (encoded === undefined || args.length > 0) {
      console.error(`error: ${command} requires one encoded internal request.`);
      return 1;
    }
    try {
      if (command === "session") return await runRemoteSession(encoded);
      if (command === "build") return await runRemoteBuildWorker(encoded);
      return await runRemoteCacheWorker(encoded);
    } catch (error) {
      console.error(`error: ${errorText(error)}`);
      return 1;
    }
  }

  try {
    if (command === "platform") {
      const json = takeFlag(args, "--json");
      assertNoArgs(args);
      const support = await inspectHostPlatform();
      if (json) console.log(JSON.stringify(support, null, 2));
      else {
        console.log(`Host: ${support.platform} (${support.environment})`);
        console.log(`Container CLI: ${support.containerCli}`);
        console.log(`Support: ${support.supported ? "supported" : "unsupported"}`);
        console.log(support.guidance);
      }
      return support.supported ? 0 : 2;
    }
    if (command === "demo") {
      const directory = takeOption(args, "--directory") ?? join(process.cwd(), "branchlift-demo");
      const noRun = takeFlag(args, "--no-run");
      const json = takeFlag(args, "--json");
      assertNoArgs(args);
      const demoRepo = await scaffoldDemoProject(directory);
      if (noRun) {
        await initializeConfig(demoRepo);
        const result = { repository: demoRepo.root, ready: false, next: "branchlift quickstart agent/demo --trust-policy" };
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`Created the BranchLift demo at ${demoRepo.root}.`);
          console.log(`Next: cd ${JSON.stringify(demoRepo.root)} && ${result.next}`);
        }
        return 0;
      }
      const result = await quickstartRepository(demoRepo, { branch: "agent/demo", start: true, trustPolicy: true });
      if (json) console.log(JSON.stringify(result, null, 2));
      else printQuickstart(result);
      return 0;
    }
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
      case "quickstart": {
        const snapshot = takeOption(args, "--snapshot");
        const noStart = takeFlag(args, "--no-start");
        const trustPolicy = takeFlag(args, "--trust-policy");
        const json = takeFlag(args, "--json");
        const branch = args.shift() ?? "agent/demo";
        assertNoArgs(args);
        const result = await quickstartRepository(repo, {
          branch,
          ...(snapshot === undefined ? {} : { snapshot }),
          start: !noStart,
          trustPolicy,
        });
        if (json) console.log(JSON.stringify(result, null, 2));
        else printQuickstart(result);
        return 0;
      }
      case "task": {
        const action = args.shift() ?? "list";
        const json = takeFlag(args, "--json");
        if (action === "list") {
          assertNoArgs(args);
          const tasks = await listWorkspaceTasks(repo);
          if (json) console.log(JSON.stringify(tasks, null, 2));
          else printWorkspaceTasks(tasks);
          return 0;
        }
        if (action === "add") {
          const prompt = takeOption(args, "--prompt");
          const branch = takeOption(args, "--branch");
          const agent = takeOption(args, "--agent");
          const statusValue = takeOption(args, "--status") ?? "backlog";
          const title = requirePositional(args, "task title");
          assertNoArgs(args);
          if (prompt === undefined) throw new BranchLiftError("task add requires --prompt TEXT.");
          const task = await createWorkspaceTask(repo, {
            title,
            prompt,
            ...(branch === undefined ? {} : { branch }),
            ...(agent === undefined ? {} : { agent }),
            status: parseWorkspaceTaskStatus(statusValue),
          });
          if (json) console.log(JSON.stringify(task, null, 2));
          else console.log(`Created ${task.id}: ${task.title} (${task.status}).`);
          return 0;
        }
        if (action === "move") {
          const id = requirePositional(args, "task id");
          const status = parseWorkspaceTaskStatus(requirePositional(args, "task status"));
          assertNoArgs(args);
          const task = await moveWorkspaceTask(repo, id, status);
          if (json) console.log(JSON.stringify(task, null, 2));
          else console.log(`Moved ${task.title} to ${task.status}.`);
          return 0;
        }
        if (action === "remove") {
          const confirm = takeOption(args, "--confirm");
          const id = requirePositional(args, "task id");
          assertNoArgs(args);
          if (confirm !== id) throw new BranchLiftError("task remove requires --confirm with the exact task id.");
          const task = await deleteWorkspaceTask(repo, id);
          if (json) console.log(JSON.stringify({ removed: task }, null, 2));
          else console.log(`Removed workspace task ${task.title}.`);
          return 0;
        }
        throw new BranchLiftError("Usage: branchlift task list|add|move|remove");
      }
      case "team": {
        const subject = args.shift();
        const action = args.shift();
        const json = takeFlag(args, "--json");
        if (subject === "registry") {
          const directory = takeOption(args, "--directory") ?? process.env.BRANCHLIFT_TEAM_REGISTRY;
          if (directory === undefined || directory.trim() === "") {
            throw new BranchLiftError("team registry requires --directory PATH or BRANCHLIFT_TEAM_REGISTRY.");
          }
          if (action === "publish") {
            assertNoArgs(args);
            const record = await publishTeamRegistry(repo, directory);
            if (json) console.log(JSON.stringify(record, null, 2));
            else console.log(`Published ${record.environments.length} environment(s), ${record.snapshots.length} snapshot(s), and ${record.tasks.length} task(s) for ${record.node.hostname}.`);
            return 0;
          }
          if (action === "list") {
            const all = takeFlag(args, "--all");
            assertNoArgs(args);
            const records = await listTeamRegistry(directory, all ? undefined : repo.key);
            if (json) console.log(JSON.stringify(records, null, 2));
            else if (records.length === 0) console.log("No shared registry nodes found.");
            else {
              console.log("UPDATED\tREPOSITORY\tNODE\tENVIRONMENTS\tSNAPSHOTS\tTASKS");
              for (const record of records) console.log(`${record.updatedAt}\t${record.repository.name}\t${record.node.hostname}\t${record.environments.length}\t${record.snapshots.length}\t${record.tasks.length}`);
            }
            return 0;
          }
          throw new BranchLiftError("Usage: branchlift team registry publish|list --directory PATH");
        }
        if (subject !== "token") throw new BranchLiftError("Usage: branchlift team token create|list|revoke or team registry publish|list");
        if (action === "create") {
          const roleValue = takeOption(args, "--role") ?? "viewer";
          const label = requirePositional(args, "token label");
          assertNoArgs(args);
          const created = await createTeamToken(repo, label, parseTeamRole(roleValue));
          if (json) console.log(JSON.stringify(created, null, 2));
          else {
            console.log(`Created ${created.definition.role} token ${created.definition.id} (${created.definition.label}).`);
            console.log(`Token: ${created.token}`);
            console.log("Store it now: BranchLift only persists its SHA-256 digest.");
          }
          return 0;
        }
        if (action === "list") {
          assertNoArgs(args);
          const tokens = await listTeamTokens(repo);
          if (json) console.log(JSON.stringify(tokens, null, 2));
          else if (tokens.length === 0) console.log("No team-access tokens for this repository.");
          else {
            console.log("ROLE\tLABEL\tID\tCREATED");
            for (const token of tokens) console.log(`${token.role}\t${token.label}\t${token.id}\t${token.createdAt}`);
          }
          return 0;
        }
        if (action === "revoke") {
          const confirm = takeOption(args, "--confirm");
          const id = requirePositional(args, "token id");
          assertNoArgs(args);
          if (confirm !== id) throw new BranchLiftError("team token revoke requires --confirm with the exact token id.");
          await revokeTeamToken(repo, id);
          if (json) console.log(JSON.stringify({ revoked: id }, null, 2));
          else console.log(`Revoked team token ${id}.`);
          return 0;
        }
        throw new BranchLiftError("Usage: branchlift team token create|list|revoke");
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
          console.log(`\nNext: review branchlift.yaml, run branchlift security trust, then branchlift snapshot ${result.config.snapshot.default}`);
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
      case "security": {
        const action = args.shift() ?? "inspect";
        if (action !== "inspect" && action !== "trust" && action !== "revoke") {
          throw new BranchLiftError("Usage: branchlift security [inspect|trust|revoke] [--json]");
        }
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const config = await loadConfig(repo);
        if (action === "trust") {
          const policy = await trustSecurityPolicy(repo, config);
          if (json) console.log(JSON.stringify(policy, null, 2));
          else console.log(`Trusted BranchLift security policy ${policy.digest} on this machine.`);
          return 0;
        }
        if (action === "revoke") {
          await revokeSecurityPolicy(repo);
          if (json) console.log(JSON.stringify({ revoked: true }, null, 2));
          else console.log("Revoked this repository's local BranchLift security-policy approval.");
          return 0;
        }
        const posture = sandboxPosture(config);
        const secrets = await inspectSecrets(repo, config);
        const result = {
          policy: await inspectPolicyTrust(repo, config),
          sandbox: posture,
          hostAgentCommands: effectiveSecurity(config).allowHostAgentCommands,
          secretCommandSources: effectiveSecurity(config).allowSecretCommands,
          secrets,
        };
        if (json) console.log(JSON.stringify(result, null, 2));
        else printSecurity(result);
        return result.policy.trusted && posture.boundary === "container" && secrets.every((secret) => !secret.required || secret.available) ? 0 : 2;
      }
      case "ui": {
        const portValue = takeOption(args, "--port");
        const noOpen = takeFlag(args, "--no-open");
        const teamAccess = takeFlag(args, "--team-access");
        assertNoArgs(args);
        const port = portValue === undefined ? undefined : Number.parseInt(portValue, 10);
        if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
          throw new BranchLiftError("--port must be an integer between 0 and 65535.");
        }
        const config = await loadConfig(repo);
        await runUiServer(repo, config, { ...(port === undefined ? {} : { port }), open: !noOpen, teamAccess });
        return 0;
      }
      case "remote": {
        const action = args.shift() ?? "list";
        const json = takeFlag(args, "--json");
        if (action === "add") {
          const repoPath = takeOption(args, "--repo");
          const user = takeOption(args, "--user");
          const portValue = takeOption(args, "--port");
          const identityFile = takeOption(args, "--identity");
          const binary = takeOption(args, "--binary");
          const name = requirePositional(args, "remote name");
          const host = requirePositional(args, "SSH host");
          assertNoArgs(args);
          if (repoPath === undefined) throw new BranchLiftError("remote add requires --repo with the absolute path on the remote host.");
          const port = portValue === undefined ? undefined : Number.parseInt(portValue, 10);
          if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
            throw new BranchLiftError("--port must be an integer between 1 and 65535.");
          }
          const remote = await addRemote({
            name,
            host,
            repoPath,
            ...(user === undefined ? {} : { user }),
            ...(port === undefined ? {} : { port }),
            ...(identityFile === undefined ? {} : { identityFile }),
            ...(binary === undefined ? {} : { binary }),
          });
          if (json) console.log(JSON.stringify(remote, null, 2));
          else console.log(`Added SSH remote ${remote.name}: ${remote.user === undefined ? "" : `${remote.user}@`}${remote.host}:${remote.repoPath}`);
          return 0;
        }
        if (action === "list") {
          assertNoArgs(args);
          const remotes = await listRemotes();
          if (json) console.log(JSON.stringify(remotes, null, 2));
          else printRemotes(remotes);
          return 0;
        }
        if (action === "remove") {
          const name = requirePositional(args, "remote name");
          assertNoArgs(args);
          await removeRemote(name);
          console.log(`Removed local remote configuration ${name}; no remote data was changed.`);
          return 0;
        }
        if (action === "setup") {
          const name = requirePositional(args, "remote name");
          assertNoArgs(args);
          const remote = await setupRemote(repo, name);
          if (json) console.log(JSON.stringify(remote, null, 2));
          else console.log(`Installed and verified BranchLift ${version} worker on ${remote.name}.`);
          return 0;
        }
        if (action === "sync") {
          const snapshotOption = takeOption(args, "--snapshot");
          const name = requirePositional(args, "remote name");
          assertNoArgs(args);
          const config = await loadConfig(repo);
          const snapshot = snapshotOption ?? config.snapshot.default;
          await ensureRemoteReady(repo, name);
          const synced = await syncRemoteCode(repo, name);
          const state = await pushRemoteSnapshot(repo, name, snapshot);
          const result = { remote: name, code: synced, state };
          if (json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(`Synchronized commit ${synced.commit.slice(0, 12)} and snapshot ${snapshot} to ${name}.`);
            console.log(`Code bundle: ${humanBytes(synced.bundleBytes)}; state transferred: ${humanBytes(state.transferredBytes)}; state blobs reused: ${state.reusedBlobs}.`);
            if (synced.dirtyPathsExcluded > 0) console.log(`Safety: excluded ${synced.dirtyPathsExcluded} uncommitted/untracked path(s).`);
          }
          return 0;
        }
        if (action === "snapshot") {
          const operation = args.shift();
          if (operation !== "push") throw new BranchLiftError("Usage: branchlift remote snapshot push REMOTE SNAPSHOT [--json]");
          const name = requirePositional(args, "remote name");
          const snapshot = requirePositional(args, "snapshot name");
          assertNoArgs(args);
          await ensureRemoteReady(repo, name);
          const pushed = await pushRemoteSnapshot(repo, name, snapshot);
          if (json) console.log(JSON.stringify(pushed, null, 2));
          else if (pushed.alreadyPresent) console.log(`Snapshot ${snapshot} is already present on ${name} (${pushed.digest}).`);
          else console.log(`Pushed snapshot ${snapshot} to ${name}: ${humanBytes(pushed.transferredBytes)} transferred, ${pushed.reusedBlobs} blob(s) reused.`);
          return 0;
        }
        if (action === "launch") {
          const snapshotOption = takeOption(args, "--snapshot");
          const noStart = takeFlag(args, "--no-start");
          const trustPolicy = takeFlag(args, "--trust-policy");
          const name = requirePositional(args, "remote name");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          const config = await loadConfig(repo);
          const snapshot = snapshotOption ?? config.snapshot.default;
          await ensureRemoteReady(repo, name);
          const code = await syncRemoteCode(repo, name);
          const state = await pushRemoteSnapshot(repo, name, snapshot);
          const expectedPolicyDigest = securityPolicyDigest(config);
          if (trustPolicy) await callRemote(repo, name, {
            action: "trust",
            expectedCommit: code.commit,
            expectedPolicyDigest,
          });
          const instance = await callRemote(repo, name, {
            action: "spawn",
            branch,
            snapshot,
            start: !noStart,
            startPoint: code.commit,
            expectedCommit: code.commit,
            expectedPolicyDigest,
          });
          const result = { remote: name, code, state, policyTrusted: trustPolicy, instance };
          if (json) console.log(JSON.stringify(result, null, 2));
          else {
            console.log(`Launched ${branch} on ${name} at ${code.commit.slice(0, 12)} from snapshot ${snapshot}.`);
            console.log(`Transferred code ${humanBytes(code.bundleBytes)} and state ${humanBytes(state.transferredBytes)}; reused ${state.reusedBlobs} state blob(s).`);
          }
          return 0;
        }
        if (action === "live-sync" || action === "watch") {
          const once = action === "live-sync" || takeFlag(args, "--once");
          const intervalValue = takeOption(args, "--interval");
          const name = requirePositional(args, "remote name");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          await ensureRemoteReady(repo, name);
          if (once) {
            const result = await syncRemoteWorkingTree(repo, name, branch);
            if (json) console.log(JSON.stringify(result, null, 2));
            else console.log(`Live-synced ${result.files} file(s) to ${name}:${branch}; ${humanBytes(result.transferredBytes)} transferred, ${result.deletedFiles} deleted.`);
            return 0;
          }
          if (json) throw new BranchLiftError("Continuous remote watch does not support --json.");
          const intervalMs = intervalValue === undefined ? 2_000 : Number.parseInt(intervalValue, 10);
          if (!Number.isInteger(intervalMs)) throw new BranchLiftError("--interval must be an integer number of milliseconds.");
          const controller = new AbortController();
          const stop = (): void => controller.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          console.log(`Watching ${repo.root} and mirroring safe working-tree changes to ${name}:${branch}. Press Ctrl-C to stop.`);
          try {
            await watchRemoteWorkingTree(repo, name, branch, {
              intervalMs,
              signal: controller.signal,
              onSync: (result) => console.log(`[${new Date().toLocaleTimeString()}] ${result.alreadyCurrent ? "verified" : "synced"} ${result.files} file(s); ${humanBytes(result.transferredBytes)} transferred.`),
            });
          } finally {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
          }
          return 0;
        }
        if (action === "tunnel") {
          const operation = args.shift() ?? "start";
          const name = requirePositional(args, "remote name");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          if (operation === "start") {
            await ensureRemoteReady(repo, name);
            const state = await startRemoteTunnels(repo, name, branch);
            if (json) console.log(JSON.stringify(state, null, 2));
            else printTunnelState(state);
          } else if (operation === "status") {
            const state = await inspectRemoteTunnel(repo, name, branch);
            if (json) console.log(JSON.stringify(state ?? null, null, 2));
            else if (state === undefined) console.log(`No active tunnel for ${name}:${branch}.`);
            else printTunnelState(state);
          } else if (operation === "stop") {
            const stopped = await stopRemoteTunnels(repo, name, branch);
            if (json) console.log(JSON.stringify({ stopped }, null, 2));
            else console.log(stopped ? `Stopped tunnels for ${name}:${branch}.` : `No tunnel was active for ${name}:${branch}.`);
          } else if (operation === "watch") {
            if (json) throw new BranchLiftError("Continuous tunnel monitoring does not support --json.");
            await ensureRemoteReady(repo, name);
            printTunnelState(await startRemoteTunnels(repo, name, branch));
            const controller = new AbortController();
            const stop = (): void => controller.abort();
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            console.log("Tunnel recovery monitor active. Press Ctrl-C to stop monitoring; the SSH tunnels remain active.");
            try {
              await monitorRemoteTunnels(repo, name, branch, {
                signal: controller.signal,
                onRestart: (state) => {
                  console.log(`[${new Date().toLocaleTimeString()}] SSH tunnels recovered.`);
                  printTunnelState(state);
                },
              });
            } finally {
              process.off("SIGINT", stop);
              process.off("SIGTERM", stop);
            }
          } else throw new BranchLiftError("Usage: branchlift remote tunnel start|status|stop|watch REMOTE BRANCH");
          return 0;
        }
        if (action === "agent" || action === "shell") {
          const separator = args.indexOf("--");
          const childCommand = separator >= 0 ? args.splice(separator + 1) : [];
          if (separator >= 0) args.splice(separator, 1);
          const network = optionalSandboxNetwork(takeOption(args, "--network"));
          const image = takeOption(args, "--image");
          const readOnlyWorktree = takeFlag(args, "--read-only-worktree");
          const name = requirePositional(args, "remote name");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          if (json) throw new BranchLiftError("Interactive remote agent sessions do not support --json.");
          const agentCommand = action === "shell" ? ["/bin/sh"] : childCommand;
          if (agentCommand.length === 0) throw new BranchLiftError("remote agent requires -- before the agent command.");
          await ensureRemoteReady(repo, name);
          return await runRemoteAgent(repo, name, branch, agentCommand, {
            ...(network === undefined ? {} : { network }),
            ...(image === undefined ? {} : { image }),
            writableWorktree: !readOnlyWorktree,
          });
        }
        if (action === "build") {
          const branch = takeOption(args, "--branch");
          const context = takeOption(args, "--context");
          const dockerfile = takeOption(args, "--file");
          const tag = takeOption(args, "--tag");
          const networkValue = takeOption(args, "--network") ?? "default";
          const cacheMax = takeOption(args, "--cache-max");
          const noCache = takeFlag(args, "--no-cache");
          const name = requirePositional(args, "remote name");
          assertNoArgs(args);
          if (json) throw new BranchLiftError("Streaming remote builds do not support --json.");
          if (tag === undefined) throw new BranchLiftError("remote build requires --tag IMAGE.");
          if (networkValue !== "default" && networkValue !== "none") throw new BranchLiftError("remote build --network must be default or none.");
          await ensureRemoteReady(repo, name);
          return await runRemoteBuild(repo, name, {
            ...(branch === undefined ? {} : { branch }),
            ...(context === undefined ? {} : { context }),
            ...(dockerfile === undefined ? {} : { dockerfile }),
            tag,
            network: networkValue,
            noCache,
            ...(cacheMax === undefined ? {} : { cacheMax }),
          });
        }
        if (action === "cache") {
          const operation = args.shift();
          const confirm = takeOption(args, "--confirm");
          const name = requirePositional(args, "remote name");
          assertNoArgs(args);
          if (json) throw new BranchLiftError("Streaming remote cache commands do not support --json.");
          if (operation !== "inspect" && operation !== "prune") throw new BranchLiftError("Usage: branchlift remote cache inspect|prune REMOTE [--confirm prune]");
          if (operation === "prune" && confirm !== "prune") throw new BranchLiftError("remote cache prune requires --confirm prune.");
          await ensureRemoteReady(repo, name);
          return await runRemoteCache(repo, name, operation, operation === "prune" ? "prune" : undefined);
        }
        if (action === "dev") {
          const snapshotOption = takeOption(args, "--snapshot");
          const trustPolicy = takeFlag(args, "--trust-policy");
          const noTunnel = takeFlag(args, "--no-tunnel");
          const intervalValue = takeOption(args, "--interval");
          const name = requirePositional(args, "remote name");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          if (json) throw new BranchLiftError("Long-running remote dev mode does not support --json.");
          const intervalMs = intervalValue === undefined ? 2_000 : Number.parseInt(intervalValue, 10);
          if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
            throw new BranchLiftError("--interval must be between 250 and 60000 milliseconds.");
          }
          const config = await loadConfig(repo);
          const snapshot = snapshotOption ?? config.snapshot.default;
          await ensureRemoteReady(repo, name);
          const code = await syncRemoteCode(repo, name);
          const state = await pushRemoteSnapshot(repo, name, snapshot);
          const expectedPolicyDigest = securityPolicyDigest(config);
          if (trustPolicy) await callRemote(repo, name, { action: "trust", expectedCommit: code.commit, expectedPolicyDigest });
          const inventory = await callRemote(repo, name, { action: "list" });
          if (!Array.isArray(inventory)) throw new BranchLiftError(`Remote ${name} returned an invalid instance list.`);
          const existing = inventory.find((item) => typeof item === "object" && item !== null && "branch" in item && item.branch === branch);
          if (existing !== undefined && (!("snapshot" in existing) || existing.snapshot !== snapshot)) {
            throw new BranchLiftError(`Remote branch ${branch} already uses a different snapshot.`, "Choose another branch or explicitly destroy the existing remote instance.");
          }
          if (existing !== undefined && (!("status" in existing) || (existing.status !== "running" && existing.status !== "stopped"))) {
            throw new BranchLiftError(`Remote branch ${branch} is not reusable because its state is not running or stopped.`, "Inspect and explicitly repair or destroy the remote instance.");
          }
          let instance: unknown;
          let initialLiveSync: Awaited<ReturnType<typeof syncRemoteWorkingTree>>;
          if (existing === undefined) {
            instance = await callRemote(repo, name, {
              action: "spawn",
              branch,
              snapshot,
              start: true,
              startPoint: code.commit,
              expectedCommit: code.commit,
              expectedPolicyDigest,
            });
            initialLiveSync = await syncRemoteWorkingTree(repo, name, branch);
          } else {
            initialLiveSync = await syncRemoteWorkingTree(repo, name, branch);
            instance = existing.status === "running"
              ? existing
              : await callRemote(repo, name, { action: "start", branch, expectedCommit: code.commit, expectedPolicyDigest });
          }
          console.log(`Remote dev environment ready on ${name}:${branch}; state ${state.digest.slice(0, 19)}…`);
          console.log(`Working tree verified (${initialLiveSync.files} safe tracked/untracked file(s), ${humanBytes(initialLiveSync.transferredBytes)} transferred).`);
          let tunnelMonitor: Promise<void> | undefined;
          if (!noTunnel) printTunnelState(await startRemoteTunnels(repo, name, branch));
          const controller = new AbortController();
          const stop = (): void => controller.abort();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          if (!noTunnel) tunnelMonitor = monitorRemoteTunnels(repo, name, branch, {
            signal: controller.signal,
            onRestart: (state) => {
              console.log(`[${new Date().toLocaleTimeString()}] SSH tunnels recovered.`);
              printTunnelState(state);
            },
          });
          console.log(`Live sync active for ${typeof instance === "object" && instance !== null && "branch" in instance ? String(instance.branch) : branch}. Press Ctrl-C to stop watching; remote backend and tunnels remain active.`);
          try {
            const fileWatch = watchRemoteWorkingTree(repo, name, branch, {
              intervalMs,
              signal: controller.signal,
              onSync: (result) => console.log(`[${new Date().toLocaleTimeString()}] ${result.alreadyCurrent ? "verified" : "synced"}; ${humanBytes(result.transferredBytes)} transferred.`),
            });
            await Promise.all(tunnelMonitor === undefined ? [fileWatch] : [fileWatch, tunnelMonitor]);
          } finally {
            controller.abort();
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
          }
          return 0;
        }
        const remoteName = requirePositional(args, "remote name");
        let result: unknown;
        if (action === "doctor" || action === "ping") {
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "ping" });
        } else if (action === "instances") {
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "list" });
        } else if (action === "preview") {
          const branch = args.shift();
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "preview", ...(branch === undefined ? {} : { branch }) });
        } else if (action === "snapshots") {
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "snapshots" });
        } else if (action === "trust") {
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "trust" });
        } else if (action === "spawn") {
          const snapshot = takeOption(args, "--snapshot");
          const noStart = takeFlag(args, "--no-start");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, {
            action: "spawn",
            branch,
            start: !noStart,
            ...(snapshot === undefined ? {} : { snapshot }),
          });
        } else if (action === "start" || action === "stop") {
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action, branch });
        } else if (action === "reset") {
          const noStart = takeFlag(args, "--no-start");
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "reset", branch, confirm: branch, start: !noStart });
        } else if (action === "destroy") {
          const branch = requirePositional(args, "branch");
          assertNoArgs(args);
          result = await callRemote(repo, remoteName, { action: "destroy", branch, confirm: branch });
        } else {
          throw new BranchLiftError(`Unknown remote action: ${action}`, "Run branchlift help for the remote command list.");
        }
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      case "secrets": {
        const action = args.shift() ?? "list";
        if (action !== "list" && action !== "doctor") {
          throw new BranchLiftError("Usage: branchlift secrets [list|doctor] [--json]");
        }
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const statuses = await inspectSecrets(repo, await loadConfig(repo));
        if (json) console.log(JSON.stringify(statuses, null, 2));
        else printSecretStatuses(statuses);
        return action === "doctor" && statuses.some((secret) => secret.required && !secret.available) ? 2 : 0;
      }
      case "events": {
        const json = takeFlag(args, "--json");
        const limitValue = takeOption(args, "--limit");
        assertNoArgs(args);
        const limit = limitValue === undefined ? 100 : Number.parseInt(limitValue, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
          throw new BranchLiftError("--limit must be an integer between 1 and 2000.");
        }
        const events = await listEvents(repo, limit);
        if (json) console.log(JSON.stringify(events, null, 2));
        else {
          if (events.length === 0) console.log("No BranchLift audit events for this repository.");
          for (const event of events) {
            console.log(`${event.timestamp}\t${event.level}\t${event.kind}\t${event.message}`);
          }
        }
        return 0;
      }
      case "sandbox": {
        const action = args.shift() ?? "inspect";
        let childCommand: string[] = [];
        if (action === "run") {
          const separator = args.indexOf("--");
          if (separator < 0) throw new BranchLiftError("branchlift sandbox run requires -- before the command.");
          childCommand = args.splice(separator + 1);
          args.splice(separator, 1);
        }
        const image = takeOption(args, "--image");
        const backendValue = takeOption(args, "--backend");
        const networkValue = takeOption(args, "--network");
        const readOnlyWorktree = takeFlag(args, "--read-only-worktree");
        const json = takeFlag(args, "--json");
        const backend = optionalSandboxBackend(backendValue);
        const network = optionalSandboxNetwork(networkValue);
        const config = await loadConfig(repo);
        const options = {
          ...(image === undefined ? {} : { image }),
          ...(backend === undefined ? {} : { backend }),
          ...(network === undefined ? {} : { network }),
          writableWorktree: !readOnlyWorktree,
        };
        if (action === "inspect") {
          assertNoArgs(args);
          const posture = sandboxPosture(config, options);
          if (json) console.log(JSON.stringify(posture, null, 2));
          else printSandboxPosture(posture);
          return posture.boundary === "container" ? 0 : 2;
        }
        if (action !== "run") throw new BranchLiftError("Usage: branchlift sandbox run BRANCH [OPTIONS] -- COMMAND ...");
        const branch = requirePositional(args, "branch");
        assertNoArgs(args);
        if (childCommand.length === 0) throw new BranchLiftError("Missing command after --.");
        if (json) throw new BranchLiftError("--json is available for sandbox inspect, not interactive sandbox run.");
        return await runSandbox(repo, config, branch, childCommand, options);
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
        if (action === "manifest") {
          args.shift();
          const json = takeFlag(args, "--json");
          const name = requirePositional(args, "snapshot name");
          assertNoArgs(args);
          const manifest = await ensureSnapshotManifest(repo, name);
          if (json) console.log(JSON.stringify(manifest, null, 2));
          else {
            console.log(`Snapshot: ${manifest.snapshot}`);
            console.log(`Content: ${manifest.digest}`);
            console.log(`Logical bytes: ${humanBytes(manifest.logicalBytes)}`);
            console.log(`Manifest entries: ${manifest.entries.length}`);
          }
          return 0;
        }
        if (action === "diff") {
          args.shift();
          const json = takeFlag(args, "--json");
          const left = requirePositional(args, "left snapshot");
          const right = requirePositional(args, "right snapshot");
          assertNoArgs(args);
          const diff = await diffSnapshots(repo, left, right);
          if (json) console.log(JSON.stringify(diff, null, 2));
          else {
            console.log(`${left} -> ${right}`);
            console.log(`Added: ${diff.added}; removed: ${diff.removed}; modified: ${diff.modified}; unchanged: ${diff.unchanged}`);
            console.log(`Shared content: ${humanBytes(diff.sharedContentBytes)}`);
            for (const entry of diff.entries.slice(0, 200)) console.log(`${entry.kind}\t${entry.volume}:${entry.path}`);
            if (diff.entries.length > 200) console.log(`... ${diff.entries.length - 200} more change(s); use --json for the complete diff.`);
          }
          return 0;
        }
        if (action === "commit") {
          args.shift();
          const json = takeFlag(args, "--json");
          const sourceBranch = takeOption(args, "--from");
          const name = requirePositional(args, "snapshot name");
          assertNoArgs(args);
          if (sourceBranch === undefined) throw new BranchLiftError("snapshot commit requires --from BRANCH.");
          const config = await loadConfig(repo);
          const inspection = await inspectConfiguredCompose(repo, config);
          if (!json) console.log(`Committing crash-consistent state from ${sourceBranch} as immutable snapshot ${name}...`);
          const result = await commitSnapshotFromInstance(repo, config, inspection, name, sourceBranch);
          if (json) console.log(JSON.stringify(result.metadata, null, 2));
          else {
            console.log(`Snapshot ${name} committed from ${sourceBranch}.`);
            console.log(`Parent: ${result.metadata.parentSnapshot}`);
            console.log(`Content: ${result.metadata.contentDigest}`);
            console.log(`Logical size: ${humanBytes(result.metadata.sizeBytes ?? 0)}`);
          }
          return 0;
        }
        if (action === "import") {
          args.shift();
          const json = takeFlag(args, "--json");
          const sourceProject = takeOption(args, "--project");
          const config = await loadConfig(repo);
          const inspection = await inspectConfiguredCompose(repo, config);
          const name = args.shift() ?? config.snapshot.default;
          assertNoArgs(args);
          if (!json) console.log(`Importing immutable snapshot ${name} from the source Compose stack...`);
          const result = await importSnapshot(repo, config, inspection, name, sourceProject);
          if (json) console.log(JSON.stringify(result.metadata, null, 2));
          else {
            console.log(`Snapshot ${name} imported; source services were restored.`);
            console.log(`State: ${result.path}`);
            console.log(`Logical size: ${humanBytes(result.metadata.sizeBytes ?? 0)}`);
          }
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
      case "gc": {
        const ageValue = takeOption(args, "--older-than") ?? "7d";
        const dryRun = takeFlag(args, "--dry-run");
        const json = takeFlag(args, "--json");
        assertNoArgs(args);
        const olderThanMs = parseAge(ageValue);
        if (olderThanMs === undefined) {
          throw new BranchLiftError("--older-than must be a positive duration such as 30m, 24h, 7d, or 2w.");
        }
        const result = await collectGarbage(repo, { olderThanMs, dryRun });
        if (json) console.log(JSON.stringify(result, null, 2));
        else {
          for (const entry of result.entries) {
            const size = humanBytes(entry.logicalBytes);
            if (entry.action === "skipped") console.log(`skipped ${entry.branch} (${entry.reason ?? "changed"})`);
            else console.log(`${entry.action} ${entry.branch} (${entry.status}, ${size})`);
          }
          if (result.entries.length === 0) console.log("No stopped or failed instances matched the age threshold.");
          if (dryRun) console.log(`Dry run: ${result.eligible} instance(s) eligible; nothing was removed.`);
          else console.log(`Removed ${result.removed} instance(s); reclaimed ${humanBytes(result.reclaimedBytes)} logical.`);
        }
        return 0;
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

function printWorkspaceTasks(tasks: WorkspaceTask[]): void {
  if (tasks.length === 0) {
    console.log("No workspace tasks for this repository.");
    return;
  }
  console.log("STATUS\tTITLE\tBRANCH\tAGENT\tID");
  for (const task of tasks) {
    console.log(`${task.status}\t${task.title}\t${task.branch ?? "-"}\t${task.agent ?? "-"}\t${task.id}`);
  }
}

function printQuickstart(result: Awaited<ReturnType<typeof quickstartRepository>>): void {
  console.log(`BranchLift environment ready: ${result.instance.branch}`);
  console.log(`Repository: ${result.repository}`);
  console.log(`Configuration: ${result.configCreated ? "created" : "reused"}`);
  console.log(`Snapshot ${result.snapshot.name}: ${result.snapshotCreated ? "created" : "reused"}`);
  console.log(`Instance: ${result.instanceCreated ? "created" : "reused"} (${result.instance.status})`);
  console.log("Next: branchlift ui");
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

function printSandboxPosture(posture: ReturnType<typeof sandboxPosture>): void {
  console.log(`Boundary: ${posture.boundary}`);
  console.log(`Backend: ${posture.backend}`);
  console.log(`Image: ${posture.image}`);
  console.log(`Network: ${posture.network}`);
  console.log(`Root filesystem: ${posture.readOnlyRoot ? "read-only" : "writable"}`);
  console.log(`Linux capabilities: ${posture.capabilities}`);
  console.log(`Host Docker socket: ${posture.hostDockerSocketMounted ? "mounted" : "not mounted"}`);
  console.log(`Limits: ${posture.resourceLimits.memory}, ${posture.resourceLimits.cpus} CPU, ${posture.resourceLimits.pids} PIDs`);
  for (const warning of posture.warnings) console.log(`warning: ${warning}`);
}

function printSecretStatuses(statuses: Awaited<ReturnType<typeof inspectSecrets>>): void {
  if (statuses.length === 0) {
    console.log("No secret definitions are configured.");
    return;
  }
  console.log("STATUS\tNAME\tSOURCE\tTARGET\tSCOPES");
  for (const secret of statuses) {
    console.log(`${secret.available ? "available" : secret.required ? "missing" : "optional"}\t${secret.name}\t${secret.source}\t${secret.target}\t${secret.scopes.join(",")}`);
    console.log(`  ${secret.message}`);
  }
}

function printSecurity(result: {
  policy: Awaited<ReturnType<typeof inspectPolicyTrust>>;
  sandbox: ReturnType<typeof sandboxPosture>;
  hostAgentCommands: boolean;
  secretCommandSources: boolean;
  secrets: Awaited<ReturnType<typeof inspectSecrets>>;
}): void {
  console.log(`Policy approval: ${result.policy.trusted ? result.policy.implicitDefault ? "implicit secure default" : "trusted" : "required"}`);
  console.log(`Policy digest: ${result.policy.digest}`);
  printSandboxPosture(result.sandbox);
  console.log(`Host agent commands: ${result.hostAgentCommands ? "allowed" : "blocked"}`);
  console.log(`Secret command sources: ${result.secretCommandSources ? "allowed" : "blocked"}`);
  printSecretStatuses(result.secrets);
}

function printRemotes(remotes: Awaited<ReturnType<typeof listRemotes>>): void {
  if (remotes.length === 0) {
    console.log("No SSH remotes configured.");
    return;
  }
  console.log("NAME\tSSH\tREPOSITORY\tBINARY");
  for (const remote of remotes) {
    const destination = `${remote.user === undefined ? "" : `${remote.user}@`}${remote.host}:${remote.port}`;
    console.log(`${remote.name}\t${destination}\t${remote.repoPath}\t${remote.binary}`);
  }
}

function printTunnelState(state: Awaited<ReturnType<typeof startRemoteTunnels>>): void {
  console.log(`SSH tunnels active for ${state.remote}:${state.branch}`);
  for (const mapping of state.mappings) {
    console.log(`  ${mapping.service}:${mapping.target} -> ${mapping.localHost}:${mapping.localPort}`);
  }
}

async function ensureRemoteReady(repo: RepoInfo, name: string): Promise<void> {
  try {
    const result = await callRemote(repo, name, { action: "ping" });
    if (typeof result === "object" && result !== null && "version" in result && result.version === version) return;
  } catch {
    // Setup below installs the current worker and returns a more specific SSH/install error if it fails.
  }
  await setupRemote(repo, name);
}

function errorText(error: unknown): string {
  const debug = process.env.BRANCHLIFT_DEBUG === "1";
  if (error instanceof BranchLiftError) {
    const text = [error.message, error.hint].filter(Boolean).join(" ");
    return debug && error.stack ? `${text}\n${error.stack}` : text;
  }
  if (error instanceof Error) return debug ? error.stack ?? error.message : error.stack ?? error.message;
  return String(error);
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

function optionalSandboxBackend(value: string | undefined): SandboxBackend | undefined {
  if (value === undefined) return undefined;
  if (value !== "docker" && value !== "host") throw new BranchLiftError("--backend must be docker or host.");
  return value;
}

function optionalSandboxNetwork(value: string | undefined): SandboxNetwork | undefined {
  if (value === undefined) return undefined;
  if (value !== "none" && value !== "backend" && value !== "outbound") {
    throw new BranchLiftError("--network must be none, backend, or outbound.");
  }
  return value;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new BranchLiftError(`Unexpected argument: ${args[0]}`);
}

function printHelp(): void {
  console.log(`BranchLift ${version} — stateful backend environments for parallel coding agents

Usage:
  branchlift demo [--directory PATH] [--no-run] [--json]
  branchlift quickstart [BRANCH] [--snapshot NAME] [--no-start] [--trust-policy] [--json]
  branchlift platform [--json]
  branchlift init [--compose FILE]... [--dry-run] [--json]
  branchlift inspect [--json]
  branchlift security inspect [--json]
  branchlift security trust|revoke [--json]
  branchlift ui [--port PORT] [--no-open] [--team-access]
  branchlift task list [--json]
  branchlift task add TITLE --prompt TEXT [--branch BRANCH] [--agent AGENT] [--status backlog|ready|running|review|done]
  branchlift task move ID backlog|ready|running|review|done
  branchlift task remove ID --confirm ID
  branchlift team token create LABEL [--role viewer|operator|admin]
  branchlift team token list [--json]
  branchlift team token revoke ID --confirm ID
  branchlift team registry publish|list --directory PATH [--json]
  branchlift remote add NAME HOST --repo REMOTE_PATH [--user USER] [--port PORT] [--identity FILE] [--binary PATH]
  branchlift remote sync NAME [--snapshot NAME]
  branchlift remote snapshot push NAME SNAPSHOT
  branchlift remote launch NAME BRANCH [--snapshot NAME] [--no-start] [--trust-policy]
  branchlift remote dev NAME BRANCH [--snapshot NAME] [--trust-policy] [--no-tunnel] [--interval MS]
  branchlift remote live-sync NAME BRANCH
  branchlift remote watch NAME BRANCH [--interval MS] [--once]
  branchlift remote tunnel start|status|stop|watch NAME BRANCH
  branchlift remote shell NAME BRANCH [--network none|backend|outbound] [--image IMAGE] [--read-only-worktree]
  branchlift remote agent NAME BRANCH [--network none|backend|outbound] [--image IMAGE] [--read-only-worktree] -- COMMAND ...
  branchlift remote build NAME --tag IMAGE [--branch BRANCH] [--context PATH] [--file DOCKERFILE] [--network default|none] [--no-cache] [--cache-max 20gb]
  branchlift remote cache inspect NAME
  branchlift remote cache prune NAME --confirm prune
  branchlift remote trust NAME
  branchlift remote list [--json]
  branchlift remote remove NAME
  branchlift remote setup NAME
  branchlift remote doctor NAME
  branchlift remote instances NAME
  branchlift remote preview NAME [BRANCH]
  branchlift remote snapshots NAME
  branchlift remote spawn NAME BRANCH [--snapshot SNAPSHOT] [--no-start]
  branchlift remote start|stop NAME BRANCH
  branchlift remote reset NAME BRANCH [--no-start]
  branchlift remote destroy NAME BRANCH
  branchlift secrets [list|doctor] [--json]
  branchlift events [--limit N] [--json]
  branchlift sandbox inspect [--backend docker|host] [--network none|backend|outbound] [--image IMAGE] [--json]
  branchlift sandbox run BRANCH [--network none|backend|outbound] [--image IMAGE] [--read-only-worktree] -- COMMAND ...
  branchlift snapshot [create] [NAME]
  branchlift snapshot import [NAME] [--project COMPOSE_PROJECT] [--json]
  branchlift snapshot list [--json]
  branchlift snapshot delete NAME
  branchlift snapshot manifest NAME [--json]
  branchlift snapshot diff LEFT RIGHT [--json]
  branchlift snapshot commit NAME --from BRANCH [--json]
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
  branchlift gc [--older-than 7d] [--dry-run] [--json]
  branchlift benchmark [SNAPSHOT] [--iterations N]
  branchlift agents install [all|codex|claude|cursor] [--dry-run] [--json]
  branchlift mcp

Examples:
  branchlift demo
  branchlift quickstart agent/auth --trust-policy
  branchlift task add "Fix auth race" --prompt "Reproduce, fix, test" --branch agent/auth --agent codex
  branchlift snapshot dev
  branchlift spawn fix-auth -- codex
  branchlift spawn billing -- claude
  branchlift attach -- codex
  branchlift agents install all
  branchlift preview
  branchlift logs fix-auth --service api --tail 100
  branchlift reset fix-auth
  branchlift gc --older-than 7d --dry-run
  branchlift exec fix-auth -- npm test

Snapshots are immutable. destroy removes BranchLift runtime state but preserves the Git
worktree and branch unless --worktree is explicitly provided.`);
}

const entry = process.argv[1];
if (entry !== undefined) {
  const resolvedEntry = await realpath(entry).catch(() => entry);
  if (import.meta.url === pathToFileURL(resolvedEntry).href) process.exitCode = await main();
}
