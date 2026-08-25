import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { generateOverride, volumeDirectoryName } from "./compose.js";
import { effectiveSecurity, loadConfig } from "./config.js";
import {
  assertDockerReady,
  composeDownBestEffort,
  composeUp,
  hydrateNativeVolumes,
  normalizeRuntimeStateOwnership,
  publishedPorts,
  reclaimManagedTreeOwnership,
  removeDockerVolumes,
  validateCompose,
} from "./docker.js";
import { BranchLiftError, errorDetail } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { assertCommittedHead, createWorktree, removeCleanWorktree } from "./git.js";
import { instanceLockScope, snapshotLockScope, withLock } from "./lock.js";
import {
  cloneDirectory,
  copyPrivateFile,
  createExclusiveDirectory,
  instanceRoot,
  makeTreeOwnerWritable,
  pathExists,
  repoDataRoot,
  safeSlug,
  snapshotRoot,
  worktreeRoot,
  writeJsonAtomic,
} from "./paths.js";
import { runCommand } from "./process.js";
import { assertSecurityPolicyTrusted } from "./policy.js";
import { readInstanceMetadata, readSnapshotMetadata, writeInstanceMetadata } from "./state.js";
import { materializeSecretEnv, mergeSecretEnvironment, redactInstanceText, resolveSecrets } from "./secrets.js";
import { projectName } from "./snapshot.js";
import type {
  ComposeInspection,
  CopyStrategy,
  BranchLiftConfig,
  InstanceMetadata,
  RepoInfo,
  VolumeBinding,
  WorktreeOwner,
} from "./types.js";

export interface SpawnOptions {
  snapshot: string;
  start: boolean;
  agentCommand: string[];
  quiet?: boolean;
  startPoint?: string;
}

export type AttachOptions = SpawnOptions;

export interface StartOptions {
  agentCommand: string[];
  quiet?: boolean;
}

export interface EnsureOptions {
  snapshot: string;
  start: boolean;
  quiet?: boolean;
}

export async function execInInstance(repo: RepoInfo, branch: string, command: string[]): Promise<number> {
  const metadata = await readInstanceMetadata(repo, safeSlug(branch));
  if (metadata.status !== "running") {
    throw new BranchLiftError(`Instance ${branch} is ${metadata.status}.`, `Run branchlift start ${branch} first.`);
  }
  if (!(await pathExists(metadata.worktreePath))) {
    throw new BranchLiftError(`Worktree is missing: ${metadata.worktreePath}`);
  }
  const [executable, ...args] = command;
  if (executable === undefined) throw new BranchLiftError("Missing command after --.");
  const contextFile = join(instanceRoot(repo, metadata.slug), "context.json");
  const config = await loadConfig(repo);
  await assertSecurityPolicyTrusted(repo, config);
  const secrets = await resolveSecrets(repo, config, "exec");
  const result = await runCommand(executable, args, {
    cwd: metadata.worktreePath,
    stdio: "inherit",
    allowFailure: true,
    env: mergeSecretEnvironment(instanceEnvironment(metadata, contextFile), secrets),
  });
  await recordEventBestEffort(repo, "instance.exec", `Command completed in ${branch}.`, {
    branch,
    details: { executable, exitCode: result.exitCode },
  });
  return result.exitCode;
}

export async function spawnInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: SpawnOptions,
): Promise<InstanceMetadata> {
  await assertSecurityPolicyTrusted(repo, config);
  const metadata = await withLock(repo, instanceLockScope(branch), "spawn", async () => {
    const slug = safeSlug(branch);
    return await provisionInstanceLocked(
      repo,
      config,
      inspection,
      branch,
      options,
      worktreeRoot(repo, slug),
      "branchlift",
      true,
      "spawn",
    );
  });
  await recordEventBestEffort(repo, "instance.spawn", `Created isolated backend for ${branch}.`, {
    branch,
    snapshot: metadata.snapshot,
    details: { status: metadata.status, copyStrategy: metadata.copyStrategy },
  });
  await launchAgent(repo, config, metadata, join(instanceRoot(repo, metadata.slug), "context.json"), options.agentCommand);
  return metadata;
}

export async function attachInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: AttachOptions,
): Promise<InstanceMetadata> {
  await assertSecurityPolicyTrusted(repo, config);
  const metadata = await withLock(repo, instanceLockScope(branch), "attach", async () => {
    return await provisionInstanceLocked(
      repo,
      config,
      inspection,
      branch,
      options,
      repo.root,
      "external",
      false,
      "attach",
    );
  });
  await recordEventBestEffort(repo, "instance.attach", `Attached backend state to ${branch}.`, {
    branch,
    snapshot: metadata.snapshot,
    details: { status: metadata.status },
  });
  await launchAgent(repo, config, metadata, join(instanceRoot(repo, metadata.slug), "context.json"), options.agentCommand);
  return metadata;
}

export async function ensureAttachedInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: EnsureOptions,
): Promise<{ instance: InstanceMetadata; action: "attached" | "started" | "reused" }> {
  await assertSecurityPolicyTrusted(repo, config);
  return await withLock(repo, instanceLockScope(branch), "ensure attach", async () => {
    const slug = safeSlug(branch);
    if (await pathExists(instanceRoot(repo, slug))) {
      const metadata = await readInstanceMetadata(repo, slug);
      if (resolve(metadata.worktreePath) !== resolve(repo.root)) {
        throw new BranchLiftError(
          `Branch ${branch} is already attached to a different worktree.`,
          `Existing: ${metadata.worktreePath}\nCurrent: ${repo.root}`,
        );
      }
      if (metadata.status === "running") return { instance: metadata, action: "reused" };
      if (metadata.status === "stopped" && options.start) {
        return {
          instance: await startInstanceLocked(repo, config, inspection, branch, options.quiet ?? false),
          action: "started",
        };
      }
      if (metadata.status === "stopped") return { instance: metadata, action: "reused" };
      throw new BranchLiftError(
        `Instance ${branch} is ${metadata.status}.`,
        `Run branchlift doctor, then reset or destroy the failed instance explicitly.`,
      );
    }
    const instance = await provisionInstanceLocked(
      repo,
      config,
      inspection,
      branch,
      { ...options, agentCommand: [] },
      repo.root,
      "external",
      false,
      "attach",
    );
    return { instance, action: "attached" };
  });
}

async function provisionInstanceLocked(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: SpawnOptions,
  worktreePath: string,
  worktreeOwner: WorktreeOwner,
  createGitWorktree: boolean,
  operation: "spawn" | "attach",
): Promise<InstanceMetadata> {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely isolatable.", inspection.blockers.join("\n"));
  }
  await assertCommittedHead(repo);
  const slug = safeSlug(branch);
  const root = instanceRoot(repo, slug);
  const prepared = await withLock(repo, snapshotLockScope(options.snapshot), operation, async () => {
    const snapshot = await readSnapshotMetadata(repo, options.snapshot);
    if (snapshot.status !== "ready") throw new BranchLiftError(`Snapshot is not ready: ${options.snapshot}`);
    if (await pathExists(root)) throw new BranchLiftError(`Instance already exists for branch ${branch}.`);
    if (createGitWorktree) await createWorktree(repo, branch, worktreePath, options.startPoint);
    else if (!(await pathExists(worktreePath))) throw new BranchLiftError(`Worktree is missing: ${worktreePath}`);
    await createExclusiveDirectory(root);

    const volumeRoot = join(root, "volumes");
    await mkdir(volumeRoot, { recursive: true });
    const overrideFile = join(root, "compose.override.yaml");
    const composeFiles = config.compose.files.map((file) => resolve(worktreePath, file));
    const primaryComposeFile = config.compose.files[0];
    if (primaryComposeFile === undefined) throw new BranchLiftError("At least one Compose file is required.");
    const composeProject = projectName(repo, `instance-${slug}`);
    const now = new Date().toISOString();
    const metadata: InstanceMetadata = {
      version: 1,
      id: randomUUID(),
      branch,
      slug,
      repoKey: repo.key,
      sourceRoot: repo.root,
      worktreePath,
      worktreeOwner,
      snapshot: options.snapshot,
      composeFile: primaryComposeFile,
      composeFiles: config.compose.files,
      overrideFile,
      volumeRoot,
      managedVolumes: inspection.volumes,
      composeProject,
      createdAt: now,
      updatedAt: now,
      status: "creating",
      ports: [],
      copyStrategy: "empty",
    };
    await writeInstanceMetadata(repo, slug, metadata);
    return { snapshot, metadata, volumeRoot, overrideFile, composeFiles, composeProject };
  });
  const { snapshot, metadata, volumeRoot, overrideFile, composeFiles, composeProject } = prepared;

  try {
    const hostUserServices = new Set<string>();
    const copyStrategies = await Promise.all(snapshot.volumeNames.map(async (volume) => {
      const source = join(snapshotRoot(repo, options.snapshot), "volumes", volumeDirectoryName(volume));
      const destination = join(volumeRoot, volumeDirectoryName(volume));
      const strategy = await cloneDirectory(source, destination);
      await makeTreeOwnerWritable(destination);
      return strategy;
    }));
    metadata.copyStrategy = copyStrategies.reduce(mergeStrategies, metadata.copyStrategy);
    const nativeVolumes = runtimeNativeVolumeMap(inspection, composeProject, metadata.id.slice(0, 8));
    if (nativeVolumes.size === 0) delete metadata.nativeVolumes;
    else metadata.nativeVolumes = Object.fromEntries(nativeVolumes);

    await copyConfiguredFiles(repo, config, worktreePath);
    const secretEnvFile = await materializeSecretEnv(repo, slug, await resolveSecrets(repo, config, "compose"));
    if (secretEnvFile === undefined) delete metadata.secretEnvFile;
    else metadata.secretEnvFile = secretEnvFile;
    await writeFile(
      overrideFile,
      generateOverride(inspection, volumeRoot, {
        randomizePorts: true,
        hostUserServices,
        ...(snapshot.postgresDataDirectories === undefined
          ? {}
          : { postgresDataDirectories: new Map(Object.entries(snapshot.postgresDataDirectories)) }),
        mysqlLowerCaseTableNames: snapshot.mysqlLowerCaseTableNames ?? 1,
        nativeVolumes,
      }),
    );
    await writeInstanceMetadata(repo, slug, metadata);
    const runtime = {
      cwd: worktreePath,
      composeFiles,
      overrideFile,
      project: composeProject,
      ...(metadata.secretEnvFile === undefined ? {} : { envFile: metadata.secretEnvFile }),
    };
    await validateCompose(runtime);
    if (options.start || nativeVolumes.size > 0) await assertDockerReady();
    const nativeBindings = bindingsForNativeVolumes(inspection.volumes, nativeVolumes);
    if (nativeBindings.length > 0) {
      await hydrateNativeVolumes(runtime, nativeBindings, volumeRoot, options.quiet ?? false);
    }

    if (options.start) {
      await composeUp(
        runtime,
        config.snapshot.healthTimeoutSeconds,
        options.quiet ?? false,
        bindingsForHostVolumes(inspection.volumes, nativeVolumes),
        volumeRoot,
      );
      metadata.ports = await publishedPorts(runtime, inspection);
      metadata.status = "running";
    } else {
      if (nativeBindings.length > 0) await composeDownBestEffort(runtime);
      metadata.status = "stopped";
    }
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    const contextFile = join(root, "context.json");
    await writeJsonAtomic(contextFile, instanceContext(metadata));
  } catch (error) {
    await markInstanceFailed(repo, slug, metadata, error);
    throw error;
  }
  return metadata;
}

export async function startInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: StartOptions,
): Promise<InstanceMetadata> {
  await assertSecurityPolicyTrusted(repo, config);
  const metadata = await withLock(repo, instanceLockScope(branch), "start", async () => {
    return await startInstanceLocked(repo, config, inspection, branch, options.quiet ?? false);
  });
  await recordEventBestEffort(repo, "instance.start", `Started ${branch}.`, {
    branch,
    snapshot: metadata.snapshot,
    details: { ports: metadata.ports.length },
  });
  await launchAgent(repo, config, metadata, join(instanceRoot(repo, metadata.slug), "context.json"), options.agentCommand);
  return metadata;
}

async function startInstanceLocked(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  quiet = false,
): Promise<InstanceMetadata> {
  const slug = safeSlug(branch);
  const metadata = await readInstanceMetadata(repo, slug);
  assertInspectionSafe(inspection);
  if (!(await pathExists(metadata.worktreePath))) {
    throw new BranchLiftError(`Worktree is missing: ${metadata.worktreePath}`);
  }
  const contextFile = join(instanceRoot(repo, slug), "context.json");
  try {
    const secretEnvFile = await materializeSecretEnv(repo, slug, await resolveSecrets(repo, config, "compose"));
    if (secretEnvFile === undefined) delete metadata.secretEnvFile;
    else metadata.secretEnvFile = secretEnvFile;
    await assertDockerReady();
    const runtime = runtimeFromMetadata(metadata);
    await validateCompose(runtime);
    await composeUp(
      runtime,
      config.snapshot.healthTimeoutSeconds,
      quiet,
      bindingsForHostVolumes(inspection.volumes, nativeVolumeMap(metadata)),
      metadata.volumeRoot,
    );
    metadata.ports = await publishedPorts(runtime, inspection);
    metadata.managedVolumes = inspection.volumes;
    metadata.status = "running";
    delete metadata.error;
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    await writeJsonAtomic(contextFile, instanceContext(metadata));
  } catch (error) {
    await markInstanceFailed(repo, slug, metadata, error);
    throw error;
  }
  return metadata;
}

export async function stopInstance(repo: RepoInfo, branch: string): Promise<InstanceMetadata> {
  const metadata = await withLock(repo, instanceLockScope(branch), "stop", async () => {
    return await stopInstanceLocked(repo, branch);
  });
  await recordEventBestEffort(repo, "instance.stop", `Stopped ${branch}; state preserved.`, {
    branch,
    snapshot: metadata.snapshot,
  });
  return metadata;
}

async function stopInstanceLocked(repo: RepoInfo, branch: string): Promise<InstanceMetadata> {
  const slug = safeSlug(branch);
  const metadata = await readInstanceMetadata(repo, slug);
  const runtime = runtimeFromMetadata(metadata);
  await normalizeRuntimeStateOwnership(
    runtime,
    bindingsForHostVolumes(metadata.managedVolumes ?? [], nativeVolumeMap(metadata)),
    metadata.volumeRoot,
  );
  await composeDownBestEffort(runtime);
  metadata.status = "stopped";
  metadata.ports = [];
  delete metadata.error;
  metadata.updatedAt = new Date().toISOString();
  await writeInstanceMetadata(repo, slug, metadata);
  await writeJsonAtomic(join(instanceRoot(repo, slug), "context.json"), instanceContext(metadata));
  return metadata;
}

export async function resetInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  start: boolean,
): Promise<InstanceMetadata> {
  await assertSecurityPolicyTrusted(repo, config);
  const metadata = await withLock(repo, instanceLockScope(branch), "reset", async () => {
    return await resetInstanceLocked(repo, config, inspection, branch, start);
  });
  await recordEventBestEffort(repo, "instance.reset", `Reset ${branch} to immutable snapshot ${metadata.snapshot}.`, {
    branch,
    snapshot: metadata.snapshot,
    details: { status: metadata.status, copyStrategy: metadata.copyStrategy },
  });
  return metadata;
}

async function resetInstanceLocked(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  start: boolean,
): Promise<InstanceMetadata> {
  const slug = safeSlug(branch);
  const metadata = await readInstanceMetadata(repo, slug);
  assertInspectionSafe(inspection);
  const snapshot = await readSnapshotMetadata(repo, metadata.snapshot);
  const root = instanceRoot(repo, slug);
  const hadVolumeRoot = metadata.volumeRoot !== undefined;
  const previousVolumeRoot = metadata.volumeRoot ?? join(root, "volumes");
  const previousOverrideFile = metadata.overrideFile;
  const previousNativeVolumes = metadata.nativeVolumes;
  assertManagedChild(previousVolumeRoot, root);
  assertManagedChild(previousOverrideFile, root);
  let pendingVolumeRoot: string | undefined;
  let pendingOverrideFile: string | undefined;
  let pendingNativeVolumes = new Map<string, string>();
  let pendingRuntime: ReturnType<typeof runtimeFromMetadata> | undefined;
  try {
    const previousRuntime = runtimeFromMetadata(metadata);
    await normalizeRuntimeStateOwnership(
      previousRuntime,
      bindingsForHostVolumes(metadata.managedVolumes ?? inspection.volumes, nativeVolumeMap(metadata)),
      previousVolumeRoot,
    );
    await composeDownBestEffort(previousRuntime);
    const generation = randomUUID().slice(0, 8);
    const volumeRoot = join(root, `volumes-${generation}`);
    const overrideFile = join(root, `compose-${generation}.override.yaml`);
    pendingNativeVolumes = runtimeNativeVolumeMap(inspection, metadata.composeProject, generation);
    pendingVolumeRoot = volumeRoot;
    pendingOverrideFile = overrideFile;
    await createExclusiveDirectory(volumeRoot);
    const hostUserServices = new Set<string>();
    const copyStrategies = await Promise.all(snapshot.volumeNames.map(async (volume) => {
      const source = join(snapshotRoot(repo, metadata.snapshot), "volumes", volumeDirectoryName(volume));
      const destination = join(volumeRoot, volumeDirectoryName(volume));
      const strategy = await cloneDirectory(source, destination);
      await makeTreeOwnerWritable(destination);
      return strategy;
    }));
    const copyStrategy = copyStrategies.reduce(mergeStrategies, "empty" as CopyStrategy);

    await writeFile(
      overrideFile,
      generateOverride(inspection, volumeRoot, {
        randomizePorts: true,
        hostUserServices,
        ...(snapshot.postgresDataDirectories === undefined
          ? {}
          : { postgresDataDirectories: new Map(Object.entries(snapshot.postgresDataDirectories)) }),
        mysqlLowerCaseTableNames: snapshot.mysqlLowerCaseTableNames ?? 1,
        nativeVolumes: pendingNativeVolumes,
      }),
    );
    const secretEnvFile = await materializeSecretEnv(repo, slug, await resolveSecrets(repo, config, "compose"));
    if (secretEnvFile === undefined) delete metadata.secretEnvFile;
    else metadata.secretEnvFile = secretEnvFile;
    const runtime = {
      cwd: metadata.worktreePath,
      composeFiles: (metadata.composeFiles ?? [metadata.composeFile]).map((file) => resolve(metadata.worktreePath, file)),
      overrideFile,
      project: metadata.composeProject,
      ...(metadata.secretEnvFile === undefined ? {} : { envFile: metadata.secretEnvFile }),
    };
    pendingRuntime = runtime;
    await validateCompose(runtime);
    if (start || pendingNativeVolumes.size > 0) await assertDockerReady();
    const nativeBindings = bindingsForNativeVolumes(inspection.volumes, pendingNativeVolumes);
    if (nativeBindings.length > 0) await hydrateNativeVolumes(runtime, nativeBindings, volumeRoot);
    if (start) {
      await composeUp(
        runtime,
        config.snapshot.healthTimeoutSeconds,
        false,
        bindingsForHostVolumes(inspection.volumes, pendingNativeVolumes),
        volumeRoot,
      );
      metadata.ports = await publishedPorts(runtime, inspection);
      metadata.status = "running";
    } else {
      if (nativeBindings.length > 0) await composeDownBestEffort(runtime);
      metadata.ports = [];
      metadata.status = "stopped";
    }
    metadata.copyStrategy = copyStrategy;
    metadata.volumeRoot = volumeRoot;
    metadata.overrideFile = overrideFile;
    metadata.managedVolumes = inspection.volumes;
    if (pendingNativeVolumes.size === 0) delete metadata.nativeVolumes;
    else metadata.nativeVolumes = Object.fromEntries(pendingNativeVolumes);
    delete metadata.error;
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    await writeJsonAtomic(join(root, "context.json"), instanceContext(metadata));
    if (previousVolumeRoot !== volumeRoot) {
      await reclaimManagedTreeOwnership(runtime, inspection.volumes, previousVolumeRoot).catch(() => undefined);
      await rm(previousVolumeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (previousOverrideFile !== overrideFile) {
      await rm(previousOverrideFile, { force: true }).catch(() => undefined);
    }
    await removeDockerVolumes(Object.values(previousNativeVolumes ?? {}), true);
  } catch (error) {
    if (pendingRuntime !== undefined) await composeDownBestEffort(pendingRuntime);
    await removeDockerVolumes(pendingNativeVolumes.values(), true);
    if (pendingVolumeRoot !== undefined) {
      await rm(pendingVolumeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (pendingOverrideFile !== undefined) await rm(pendingOverrideFile, { force: true }).catch(() => undefined);
    metadata.overrideFile = previousOverrideFile;
    if (hadVolumeRoot) metadata.volumeRoot = previousVolumeRoot;
    else delete metadata.volumeRoot;
    if (previousNativeVolumes === undefined) delete metadata.nativeVolumes;
    else metadata.nativeVolumes = previousNativeVolumes;
    await markInstanceFailed(repo, slug, metadata, error);
    throw error;
  }
  return metadata;
}

export async function destroyInstance(
  repo: RepoInfo,
  branch: string,
  removeWorktree: boolean,
): Promise<{ runtimeRemoved: boolean; worktreeRemoved: boolean }> {
  const result = await withLock(repo, instanceLockScope(branch), "destroy", async () => {
    return await destroyInstanceLocked(repo, branch, removeWorktree);
  });
  await recordEventBestEffort(repo, "instance.destroy", `Destroyed runtime state for ${branch}.`, {
    branch,
    details: result,
  });
  return result;
}

export async function destroyInstanceIfUnchanged(
  repo: RepoInfo,
  expected: Pick<InstanceMetadata, "branch" | "status" | "updatedAt">,
  removeWorktree: boolean,
): Promise<
  | { removed: true; runtimeRemoved: boolean; worktreeRemoved: boolean }
  | { removed: false; reason: string }
> {
  return await withLock(repo, instanceLockScope(expected.branch), "garbage collect", async () => {
    const root = instanceRoot(repo, safeSlug(expected.branch));
    if (!(await pathExists(root))) return { removed: false, reason: "instance disappeared before collection" };
    const current = await readInstanceMetadata(repo, safeSlug(expected.branch));
    if (current.updatedAt !== expected.updatedAt || current.status !== expected.status) {
      return { removed: false, reason: `instance changed to ${current.status} before collection` };
    }
    if (current.status !== "stopped" && current.status !== "failed") {
      return { removed: false, reason: `status ${current.status} is not collectible` };
    }
    const result = await destroyInstanceLocked(repo, current.branch, removeWorktree);
    return { removed: true, ...result };
  });
}

async function destroyInstanceLocked(
  repo: RepoInfo,
  branch: string,
  removeWorktree: boolean,
): Promise<{ runtimeRemoved: boolean; worktreeRemoved: boolean }> {
  const slug = safeSlug(branch);
  const root = instanceRoot(repo, slug);
  if (!(await pathExists(root))) throw new BranchLiftError(`No BranchLift instance found for branch ${branch}.`);
  const metadata = await readInstanceMetadata(repo, slug);
  if (removeWorktree && metadata.worktreeOwner === "external") {
    throw new BranchLiftError(
      `Refusing to remove an externally owned worktree: ${metadata.worktreePath}`,
      `Run branchlift destroy ${branch} without --worktree; remove the worktree yourself if desired.`,
    );
  }
  const runtime = runtimeFromMetadata(metadata);
  if ((await Promise.all(runtime.composeFiles.map(async (file) => await pathExists(file)))).every(Boolean) && (await pathExists(runtime.overrideFile))) {
    await normalizeRuntimeStateOwnership(
      runtime,
      bindingsForHostVolumes(metadata.managedVolumes ?? [], nativeVolumeMap(metadata)),
      metadata.volumeRoot,
    );
    await composeDownBestEffort(runtime);
  }

  let worktreeRemoved = false;
  if (removeWorktree) {
    await removeCleanWorktree(repo, metadata.worktreePath);
    worktreeRemoved = true;
  }

  const managedParent = resolve(repoDataRoot(repo), "instances");
  const resolvedRoot = resolve(root);
  if (!resolvedRoot.startsWith(`${managedParent}/`)) {
    throw new BranchLiftError(`Refusing to remove a path outside BranchLift state: ${resolvedRoot}`);
  }
  await reclaimManagedTreeOwnership(
    runtime,
    bindingsForHostVolumes(metadata.managedVolumes ?? [], nativeVolumeMap(metadata)),
    metadata.volumeRoot,
  ).catch(() => undefined);
  await removeDockerVolumes(Object.values(metadata.nativeVolumes ?? {}), true);
  await rm(resolvedRoot, { recursive: true, force: false });
  return { runtimeRemoved: true, worktreeRemoved };
}

export function instanceContext(metadata: InstanceMetadata): Record<string, unknown> {
  const urls: Record<string, string[]> = {};
  for (const port of metadata.ports) {
    const values = urls[port.service] ?? [];
    values.push(`${port.protocol}://${normalizeHost(port.host)}:${port.port}`);
    urls[port.service] = values;
  }
  return {
    instance: metadata.id,
    branch: metadata.branch,
    worktree: metadata.worktreePath,
    composeProject: metadata.composeProject,
    snapshot: metadata.snapshot,
    ports: metadata.ports,
    endpoints: urls,
  };
}

async function launchAgent(
  repo: RepoInfo,
  config: BranchLiftConfig,
  metadata: InstanceMetadata,
  contextFile: string,
  agentCommand: string[],
): Promise<void> {
  if (agentCommand.length === 0) return;
  if (!effectiveSecurity(config).allowHostAgentCommands) {
    throw new BranchLiftError(
      "Host agent commands are disabled by the BranchLift security policy.",
      `Run branchlift sandbox run ${metadata.branch} -- COMMAND, or explicitly set security.allowHostAgentCommands: true.`,
    );
  }
  await assertSecurityPolicyTrusted(repo, config);
  const [command, ...args] = agentCommand;
  if (command === undefined) throw new BranchLiftError("Agent command is empty.");
  const secrets = await resolveSecrets(repo, config, "agent");
  await runCommand(command, args, {
    cwd: metadata.worktreePath,
    stdio: "inherit",
    env: mergeSecretEnvironment(instanceEnvironment(metadata, contextFile), secrets),
  });
}

export function instanceEnvironment(metadata: InstanceMetadata, contextFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BRANCHLIFT_INSTANCE: metadata.id,
    BRANCHLIFT_CONTEXT: contextFile,
    BRANCHLIFT_WORKTREE: metadata.worktreePath,
    COMPOSE_PROJECT_NAME: metadata.composeProject,
  };
  for (const port of metadata.ports) {
    const prefix = `BRANCHLIFT_${environmentName(port.service)}_${port.target}`;
    env[`${prefix}_HOST`] = normalizeHost(port.host);
    env[`${prefix}_PORT`] = String(port.port);
    env[`${prefix}_URL`] = `${port.protocol}://${normalizeHost(port.host)}:${port.port}`;
  }
  return env;
}

function environmentName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SERVICE";
}

export async function copyConfiguredFiles(repo: RepoInfo, config: BranchLiftConfig, targetRoot: string): Promise<void> {
  const realRepoRoot = await realpath(repo.root);
  const realTargetRoot = await realpath(targetRoot);
  for (const relativePath of config.worktree.copyFiles) {
    if (relativePath.includes("..") || resolve(repo.root, relativePath) === repo.root) {
      throw new BranchLiftError(`Unsafe worktree.copyFiles entry: ${relativePath}`);
    }
    const source = resolve(repo.root, relativePath);
    const destination = resolve(targetRoot, relativePath);
    if (!source.startsWith(`${repo.root}/`) || !destination.startsWith(`${targetRoot}/`)) {
      throw new BranchLiftError(`copyFiles entry escapes the repository: ${relativePath}`);
    }
    if (!(await pathExists(source)) || (await pathExists(destination))) continue;
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new BranchLiftError(`worktree.copyFiles must reference a regular file, not a symlink: ${relativePath}`);
    }
    const realSource = await realpath(source);
    if (!isWithin(realSource, realRepoRoot)) {
      throw new BranchLiftError(`copyFiles source resolves outside the repository: ${relativePath}`);
    }
    const safeDestination = resolve(realTargetRoot, relative(targetRoot, destination));
    await createSafeCopyParent(realTargetRoot, dirname(safeDestination));
    await copyPrivateFile(source, safeDestination);
  }
}

async function createSafeCopyParent(targetRoot: string, destinationParent: string): Promise<void> {
  const relativeParent = relative(targetRoot, destinationParent);
  if (relativeParent === "") return;
  if (relativeParent.startsWith("..") || resolve(targetRoot, relativeParent) !== destinationParent) {
    throw new BranchLiftError(`copyFiles destination escapes the managed worktree: ${destinationParent}`);
  }
  let current = targetRoot;
  for (const segment of relativeParent.split(sep)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new BranchLiftError(`copyFiles destination contains an unsafe path component: ${current}`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  const resolvedParent = await realpath(destinationParent);
  if (!isWithin(resolvedParent, targetRoot)) {
    throw new BranchLiftError(`copyFiles destination resolves outside the managed worktree: ${destinationParent}`);
  }
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function mergeStrategies(current: CopyStrategy, next: CopyStrategy): CopyStrategy {
  const rank: Record<CopyStrategy, number> = {
    empty: 0,
    "apfs-clone": 1,
    "linux-reflink": 1,
    "recursive-copy": 2,
  };
  return rank[next] > rank[current] ? next : current;
}

function normalizeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function runtimeFromMetadata(metadata: InstanceMetadata) {
  return {
    cwd: metadata.worktreePath,
    composeFiles: (metadata.composeFiles ?? [metadata.composeFile]).map((file) => resolve(metadata.worktreePath, file)),
    overrideFile: metadata.overrideFile,
    project: metadata.composeProject,
    ...(metadata.secretEnvFile === undefined ? {} : { envFile: metadata.secretEnvFile }),
  };
}

/** MongoDB/WiredTiger cannot reliably reopen Docker Desktop bind mounts on macOS. */
export function runtimeNativeVolumeMap(
  inspection: ComposeInspection,
  project: string,
  generation: string,
  platform = process.platform,
): Map<string, string> {
  if (platform !== "darwin") return new Map();
  const mongodbServices = new Set(inspection.mongodbServices);
  return new Map(
    inspection.volumes
      .filter((volume) => !volume.readOnly && mongodbServices.has(volume.service))
      .map((volume) => [
        volume.source,
        `${project}-${volumeDirectoryName(volume.source)}-${safeSlug(generation)}`,
      ] as const),
  );
}

function nativeVolumeMap(metadata: InstanceMetadata): Map<string, string> {
  return new Map(Object.entries(metadata.nativeVolumes ?? {}));
}

function bindingsForNativeVolumes(volumes: VolumeBinding[], nativeVolumes: ReadonlyMap<string, string>): VolumeBinding[] {
  return volumes.filter((volume) => nativeVolumes.has(volume.source));
}

function bindingsForHostVolumes(volumes: VolumeBinding[], nativeVolumes: ReadonlyMap<string, string>): VolumeBinding[] {
  return volumes.filter((volume) => !nativeVolumes.has(volume.source));
}

function assertManagedChild(path: string, parent: string): void {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parent);
  if (!resolvedPath.startsWith(`${resolvedParent}/`)) {
    throw new BranchLiftError(`Refusing to modify a path outside managed state: ${resolvedPath}`);
  }
}

async function markInstanceFailed(
  repo: RepoInfo,
  slug: string,
  metadata: InstanceMetadata,
  error: unknown,
): Promise<void> {
  metadata.status = "failed";
  metadata.ports = [];
  metadata.error = await redactInstanceText(repo, slug, errorDetail(error)).catch(() => "Instance operation failed; diagnostic redaction was unavailable.");
  metadata.updatedAt = new Date().toISOString();
  await writeInstanceMetadata(repo, slug, metadata);
  await writeJsonAtomic(join(instanceRoot(repo, slug), "context.json"), instanceContext(metadata));
}

function assertInspectionSafe(inspection: ComposeInspection): void {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely isolatable.", inspection.blockers.join("\n"));
  }
}
