import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { generateOverride, volumeDirectoryName } from "./compose.js";
import {
  assertDockerReady,
  composeDownBestEffort,
  composeUp,
  normalizeRuntimeStateOwnership,
  publishedPorts,
  validateCompose,
} from "./docker.js";
import { BranchLiftError, errorDetail } from "./errors.js";
import { assertCommittedHead, createWorktree, removeCleanWorktree } from "./git.js";
import { instanceLockScope, snapshotLockScope, withLock } from "./lock.js";
import {
  cloneDirectory,
  copyPrivateFile,
  createExclusiveDirectory,
  instanceRoot,
  makeTreeContainerWritable,
  pathExists,
  repoDataRoot,
  safeSlug,
  snapshotRoot,
  worktreeRoot,
  writeJsonAtomic,
} from "./paths.js";
import { runCommand } from "./process.js";
import { readInstanceMetadata, readSnapshotMetadata, writeInstanceMetadata } from "./state.js";
import { projectName } from "./snapshot.js";
import type {
  ComposeInspection,
  CopyStrategy,
  BranchLiftConfig,
  InstanceMetadata,
  RepoInfo,
  WorktreeOwner,
} from "./types.js";

export interface SpawnOptions {
  snapshot: string;
  start: boolean;
  agentCommand: string[];
  quiet?: boolean;
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
  const result = await runCommand(executable, args, {
    cwd: metadata.worktreePath,
    stdio: "inherit",
    allowFailure: true,
    env: instanceEnvironment(metadata, contextFile),
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
  await launchAgent(metadata, join(instanceRoot(repo, metadata.slug), "context.json"), options.agentCommand);
  return metadata;
}

export async function attachInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: AttachOptions,
): Promise<InstanceMetadata> {
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
  await launchAgent(metadata, join(instanceRoot(repo, metadata.slug), "context.json"), options.agentCommand);
  return metadata;
}

export async function ensureAttachedInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: EnsureOptions,
): Promise<{ instance: InstanceMetadata; action: "attached" | "started" | "reused" }> {
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
    if (createGitWorktree) await createWorktree(repo, branch, worktreePath);
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
    const databaseServices = new Set([...inspection.postgresServices, ...inspection.mysqlServices]);
    const genericVolumeSources = new Set(
      inspection.volumes
        .filter((volume) => !databaseServices.has(volume.service) && !volume.readOnly)
        .map((volume) => volume.source),
    );
    const copyStrategies = await Promise.all(snapshot.volumeNames.map(async (volume) => {
      const source = join(snapshotRoot(repo, options.snapshot), "volumes", volumeDirectoryName(volume));
      const destination = join(volumeRoot, volumeDirectoryName(volume));
      const strategy = await cloneDirectory(source, destination);
      if (genericVolumeSources.has(volume)) await makeTreeContainerWritable(destination);
      return strategy;
    }));
    metadata.copyStrategy = copyStrategies.reduce(mergeStrategies, metadata.copyStrategy);

    await copyConfiguredFiles(repo, config, worktreePath);
    await writeFile(
      overrideFile,
      generateOverride(inspection, volumeRoot, {
        randomizePorts: true,
        hostUserServices,
        ...(snapshot.postgresDataDirectories === undefined
          ? {}
          : { postgresDataDirectories: new Map(Object.entries(snapshot.postgresDataDirectories)) }),
        mysqlLowerCaseTableNames: snapshot.mysqlLowerCaseTableNames ?? 1,
      }),
    );
    await writeInstanceMetadata(repo, slug, metadata);
    const runtime = { cwd: worktreePath, composeFiles, overrideFile, project: composeProject };
    await validateCompose(runtime);

    if (options.start) {
      await assertDockerReady();
      await composeUp(runtime, config.snapshot.healthTimeoutSeconds, options.quiet ?? false, inspection.volumes);
      metadata.ports = await publishedPorts(runtime, inspection);
      metadata.status = "running";
    } else {
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
  const metadata = await withLock(repo, instanceLockScope(branch), "start", async () => {
    return await startInstanceLocked(repo, config, inspection, branch, options.quiet ?? false);
  });
  await launchAgent(metadata, join(instanceRoot(repo, metadata.slug), "context.json"), options.agentCommand);
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
    await assertDockerReady();
    const runtime = runtimeFromMetadata(metadata);
    await validateCompose(runtime);
    await composeUp(runtime, config.snapshot.healthTimeoutSeconds, quiet, inspection.volumes);
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
  return await withLock(repo, instanceLockScope(branch), "stop", async () => {
    return await stopInstanceLocked(repo, branch);
  });
}

async function stopInstanceLocked(repo: RepoInfo, branch: string): Promise<InstanceMetadata> {
  const slug = safeSlug(branch);
  const metadata = await readInstanceMetadata(repo, slug);
  const runtime = runtimeFromMetadata(metadata);
  await normalizeRuntimeStateOwnership(runtime, metadata.managedVolumes ?? []);
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
  return await withLock(repo, instanceLockScope(branch), "reset", async () => {
    return await resetInstanceLocked(repo, config, inspection, branch, start);
  });
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
  assertManagedChild(previousVolumeRoot, root);
  assertManagedChild(previousOverrideFile, root);
  let pendingVolumeRoot: string | undefined;
  let pendingOverrideFile: string | undefined;
  let generationAdopted = false;
  try {
    const previousRuntime = runtimeFromMetadata(metadata);
    await normalizeRuntimeStateOwnership(previousRuntime, metadata.managedVolumes ?? inspection.volumes);
    await composeDownBestEffort(previousRuntime);
    const generation = randomUUID().slice(0, 8);
    const volumeRoot = join(root, `volumes-${generation}`);
    const overrideFile = join(root, `compose-${generation}.override.yaml`);
    pendingVolumeRoot = volumeRoot;
    pendingOverrideFile = overrideFile;
    await createExclusiveDirectory(volumeRoot);
    const hostUserServices = new Set<string>();
    const databaseServices = new Set([...inspection.postgresServices, ...inspection.mysqlServices]);
    const genericVolumeSources = new Set(
      inspection.volumes
        .filter((volume) => !databaseServices.has(volume.service) && !volume.readOnly)
        .map((volume) => volume.source),
    );
    const copyStrategies = await Promise.all(snapshot.volumeNames.map(async (volume) => {
      const source = join(snapshotRoot(repo, metadata.snapshot), "volumes", volumeDirectoryName(volume));
      const destination = join(volumeRoot, volumeDirectoryName(volume));
      const strategy = await cloneDirectory(source, destination);
      if (genericVolumeSources.has(volume)) await makeTreeContainerWritable(destination);
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
      }),
    );
    const runtime = {
      cwd: metadata.worktreePath,
      composeFiles: (metadata.composeFiles ?? [metadata.composeFile]).map((file) => resolve(metadata.worktreePath, file)),
      overrideFile,
      project: metadata.composeProject,
    };
    await validateCompose(runtime);

    metadata.copyStrategy = copyStrategy;
    metadata.ports = [];
    metadata.volumeRoot = volumeRoot;
    metadata.overrideFile = overrideFile;
    metadata.managedVolumes = inspection.volumes;
    metadata.status = "creating";
    delete metadata.error;
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    generationAdopted = true;
    await writeJsonAtomic(join(root, "context.json"), instanceContext(metadata));
    if (start) {
      await assertDockerReady();
      await composeUp(runtime, config.snapshot.healthTimeoutSeconds, false, inspection.volumes);
      metadata.ports = await publishedPorts(runtime, inspection);
      metadata.status = "running";
    } else {
      metadata.status = "stopped";
    }
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    await writeJsonAtomic(join(root, "context.json"), instanceContext(metadata));
    if (previousVolumeRoot !== volumeRoot) {
      await rm(previousVolumeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    if (previousOverrideFile !== overrideFile) {
      await rm(previousOverrideFile, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    if (!generationAdopted) {
      if (pendingVolumeRoot !== undefined) {
        await rm(pendingVolumeRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      if (pendingOverrideFile !== undefined) {
        await rm(pendingOverrideFile, { force: true }).catch(() => undefined);
      }
      metadata.overrideFile = previousOverrideFile;
      if (hadVolumeRoot) metadata.volumeRoot = previousVolumeRoot;
      else delete metadata.volumeRoot;
    }
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
  return await withLock(repo, instanceLockScope(branch), "destroy", async () => {
    return await destroyInstanceLocked(repo, branch, removeWorktree);
  });
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
    await normalizeRuntimeStateOwnership(runtime, metadata.managedVolumes ?? []);
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

async function launchAgent(metadata: InstanceMetadata, contextFile: string, agentCommand: string[]): Promise<void> {
  if (agentCommand.length === 0) return;
  const [command, ...args] = agentCommand;
  if (command === undefined) throw new BranchLiftError("Agent command is empty.");
  await runCommand(command, args, {
    cwd: metadata.worktreePath,
    stdio: "inherit",
    env: instanceEnvironment(metadata, contextFile),
  });
}

function instanceEnvironment(metadata: InstanceMetadata, contextFile: string): NodeJS.ProcessEnv {
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

async function copyConfiguredFiles(repo: RepoInfo, config: BranchLiftConfig, targetRoot: string): Promise<void> {
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
    await mkdir(dirname(destination), { recursive: true });
    await copyPrivateFile(source, destination);
  }
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
  };
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
  metadata.error = errorDetail(error);
  metadata.updatedAt = new Date().toISOString();
  await writeInstanceMetadata(repo, slug, metadata);
  await writeJsonAtomic(join(instanceRoot(repo, slug), "context.json"), instanceContext(metadata));
}

function assertInspectionSafe(inspection: ComposeInspection): void {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely isolatable.", inspection.blockers.join("\n"));
  }
}
