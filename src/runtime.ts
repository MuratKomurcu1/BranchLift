import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { generateOverride, volumeDirectoryName } from "./compose.js";
import {
  assertDockerReady,
  composeDownBestEffort,
  composeUp,
  publishedPorts,
  validateCompose,
} from "./docker.js";
import { BranchLiftError } from "./errors.js";
import { assertCommittedHead, createWorktree, removeCleanWorktree } from "./git.js";
import {
  cloneDirectory,
  copyPrivateFile,
  createExclusiveDirectory,
  instanceRoot,
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
} from "./types.js";

export interface SpawnOptions {
  snapshot: string;
  start: boolean;
  agentCommand: string[];
}

export interface StartOptions {
  agentCommand: string[];
}

export async function spawnInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: SpawnOptions,
): Promise<InstanceMetadata> {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely isolatable.", inspection.blockers.join("\n"));
  }
  await assertCommittedHead(repo);
  const snapshot = await readSnapshotMetadata(repo, options.snapshot);
  if (snapshot.status !== "ready") throw new BranchLiftError(`Snapshot is not ready: ${options.snapshot}`);

  const slug = safeSlug(branch);
  const root = instanceRoot(repo, slug);
  if (await pathExists(root)) throw new BranchLiftError(`Instance already exists for branch ${branch}.`);
  const worktreePath = worktreeRoot(repo, slug);
  await createWorktree(repo, branch, worktreePath);
  await createExclusiveDirectory(root);

  const volumeRoot = join(root, "volumes");
  await mkdir(volumeRoot, { recursive: true });
  const overrideFile = join(root, "compose.override.yaml");
  const composeFile = resolve(worktreePath, config.compose.file);
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
    snapshot: options.snapshot,
    composeFile: config.compose.file,
    overrideFile,
    composeProject,
    createdAt: now,
    updatedAt: now,
    status: "creating",
    ports: [],
    copyStrategy: "empty",
  };
  await writeInstanceMetadata(repo, slug, metadata);

  try {
    for (const volume of snapshot.volumeNames) {
      const source = join(snapshotRoot(repo, options.snapshot), "volumes", volumeDirectoryName(volume));
      const destination = join(volumeRoot, volumeDirectoryName(volume));
      const strategy = await cloneDirectory(source, destination);
      metadata.copyStrategy = mergeStrategies(metadata.copyStrategy, strategy);
    }

    await copyConfiguredFiles(repo, config, worktreePath);
    await writeFile(overrideFile, generateOverride(inspection, volumeRoot, { randomizePorts: true }));
    await writeInstanceMetadata(repo, slug, metadata);
    const runtime = { cwd: worktreePath, composeFile, overrideFile, project: composeProject };
    await validateCompose(runtime);

    if (options.start) {
      await assertDockerReady();
      await composeUp(runtime, config.snapshot.healthTimeoutSeconds);
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
  const contextFile = join(root, "context.json");
  await launchAgent(metadata, contextFile, options.agentCommand);
  return metadata;
}

export async function startInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  branch: string,
  options: StartOptions,
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
    await composeUp(runtime, config.snapshot.healthTimeoutSeconds);
    metadata.ports = await publishedPorts(runtime, inspection);
    metadata.status = "running";
    delete metadata.error;
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    await writeJsonAtomic(contextFile, instanceContext(metadata));
  } catch (error) {
    await markInstanceFailed(repo, slug, metadata, error);
    throw error;
  }
  await launchAgent(metadata, contextFile, options.agentCommand);
  return metadata;
}

export async function stopInstance(repo: RepoInfo, branch: string): Promise<InstanceMetadata> {
  const slug = safeSlug(branch);
  const metadata = await readInstanceMetadata(repo, slug);
  await composeDownBestEffort(runtimeFromMetadata(metadata));
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
  const slug = safeSlug(branch);
  const metadata = await readInstanceMetadata(repo, slug);
  assertInspectionSafe(inspection);
  const snapshot = await readSnapshotMetadata(repo, metadata.snapshot);
  const root = instanceRoot(repo, slug);
  try {
    await composeDownBestEffort(runtimeFromMetadata(metadata));
    const volumeRoot = join(root, "volumes");
    assertManagedChild(volumeRoot, root);
    await mkdir(volumeRoot, { recursive: true });
    let copyStrategy: CopyStrategy = "empty";
    for (const volume of snapshot.volumeNames) {
      const source = join(snapshotRoot(repo, metadata.snapshot), "volumes", volumeDirectoryName(volume));
      const destination = join(volumeRoot, volumeDirectoryName(volume));
      await mkdir(destination, { recursive: true });
      await clearDirectory(destination, volumeRoot);
      copyStrategy = mergeStrategies(copyStrategy, await cloneDirectory(source, destination));
    }

    metadata.copyStrategy = copyStrategy;
    metadata.ports = [];
    delete metadata.error;
    if (start) {
      await assertDockerReady();
      await composeUp(runtimeFromMetadata(metadata), config.snapshot.healthTimeoutSeconds);
      metadata.ports = await publishedPorts(runtimeFromMetadata(metadata), inspection);
      metadata.status = "running";
    } else {
      metadata.status = "stopped";
    }
    metadata.updatedAt = new Date().toISOString();
    await writeInstanceMetadata(repo, slug, metadata);
    await writeJsonAtomic(join(root, "context.json"), instanceContext(metadata));
  } catch (error) {
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
  const slug = safeSlug(branch);
  const root = instanceRoot(repo, slug);
  if (!(await pathExists(root))) throw new BranchLiftError(`No BranchLift instance found for branch ${branch}.`);
  const metadata = await readInstanceMetadata(repo, slug);
  const runtime = runtimeFromMetadata(metadata);
  if ((await pathExists(runtime.composeFile)) && (await pathExists(runtime.overrideFile))) {
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

function instanceContext(metadata: InstanceMetadata): Record<string, unknown> {
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
    env: {
      ...process.env,
      BRANCHLIFT_INSTANCE: metadata.id,
      BRANCHLIFT_CONTEXT: contextFile,
      BRANCHLIFT_WORKTREE: metadata.worktreePath,
      COMPOSE_PROJECT_NAME: metadata.composeProject,
    },
  });
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

function runtimeFromMetadata(metadata: InstanceMetadata) {
  return {
    cwd: metadata.worktreePath,
    composeFile: resolve(metadata.worktreePath, metadata.composeFile),
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

async function clearDirectory(path: string, managedParent: string): Promise<void> {
  assertManagedChild(path, managedParent);
  for (const entry of await readdir(path)) {
    const child = join(path, entry);
    assertManagedChild(child, path);
    await rm(child, { recursive: true, force: true });
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
  metadata.error = error instanceof Error ? error.message : String(error);
  metadata.updatedAt = new Date().toISOString();
  await writeInstanceMetadata(repo, slug, metadata);
  await writeJsonAtomic(join(instanceRoot(repo, slug), "context.json"), instanceContext(metadata));
}

function assertInspectionSafe(inspection: ComposeInspection): void {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely isolatable.", inspection.blockers.join("\n"));
  }
}
