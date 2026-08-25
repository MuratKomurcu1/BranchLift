import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { generateOverride, volumeDirectoryName } from "./compose.js";
import {
  assertDockerReady,
  composeDown,
  composeDownBestEffort,
  composeSeed,
  composeStop,
  composeUp,
  copyServicePathToHost,
  copySourceServicePathToHost,
  removeDockerVolumes,
  normalizeRuntimeStateOwnership,
  publishedPorts,
  sourceRunningServices,
  startSourceServices,
  stopSourceServices,
  validateCompose,
} from "./docker.js";
import { BranchLiftError, errorDetail } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { instanceLockScope, snapshotLockScope, withLock } from "./lock.js";
import { createSnapshotManifest, writeSnapshotManifest } from "./manifest.js";
import { cloneDirectory, directorySize, instanceRoot, makeTreeReadOnly, pathExists, safeSlug, snapshotRoot, writeJsonAtomic } from "./paths.js";
import type { SourceComposeRuntime } from "./docker.js";
import type { ComposeInspection, BranchLiftConfig, RepoInfo, SnapshotMetadata, VolumeBinding } from "./types.js";
import type { CopyStrategy, InstanceMetadata } from "./types.js";
import { readInstanceMetadata, readSnapshotMetadata, writeInstanceMetadata } from "./state.js";
import { assertSecurityPolicyTrusted } from "./policy.js";
import { createComposeSecretSession, redactEnvFileText, redactInstanceText } from "./secrets.js";

export interface SnapshotResult {
  metadata: SnapshotMetadata;
  path: string;
}

export interface SnapshotImportAdapter {
  assertReady(): Promise<void>;
  runningServices(runtime: SourceComposeRuntime): Promise<string[]>;
  stop(runtime: SourceComposeRuntime, services: string[]): Promise<void>;
  start(runtime: SourceComposeRuntime, services: string[]): Promise<void>;
  copy(runtime: SourceComposeRuntime, volume: VolumeBinding, destination: string): Promise<void>;
}

const dockerImportAdapter: SnapshotImportAdapter = {
  assertReady: assertDockerReady,
  runningServices: sourceRunningServices,
  stop: stopSourceServices,
  start: startSourceServices,
  copy: async (runtime, volume, destination) => {
    await copySourceServicePathToHost(runtime, volume.service, volume.target, destination);
  },
};

export async function createSnapshot(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
): Promise<SnapshotResult> {
  await assertSecurityPolicyTrusted(repo, config);
  const session = await createComposeSecretSession(repo, config);
  const result = await (async () => {
    try {
      return await withLock(repo, snapshotLockScope(name), "snapshot create", async () => {
        return await createSnapshotUnlocked(repo, config, inspection, name, session.envFile);
      });
    } finally {
      await session.close();
    }
  })();
  await recordEventBestEffort(repo, "snapshot.create", `Created immutable snapshot ${name}.`, {
    snapshot: name,
    details: { logicalBytes: result.metadata.sizeBytes ?? 0 },
  });
  return result;
}

export async function importSnapshot(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
  sourceProject?: string,
  adapter: SnapshotImportAdapter = dockerImportAdapter,
): Promise<SnapshotResult> {
  await assertSecurityPolicyTrusted(repo, config);
  const session = await createComposeSecretSession(repo, config);
  const result = await (async () => {
    try {
      return await withLock(repo, snapshotLockScope(name), "snapshot import", async () => {
    if (inspection.blockers.length > 0) {
      throw new BranchLiftError(
        "Compose project is not safely cloneable.",
        inspection.blockers.map((blocker) => `- ${blocker}`).join("\n"),
      );
    }
    if (config.compose.statefulServices.length === 0 || inspection.volumes.length === 0) {
      throw new BranchLiftError("No stateful services with named volumes were found.");
    }
    await adapter.assertReady();

    const finalPath = snapshotRoot(repo, name);
    if (await pathExists(finalPath)) {
      throw new BranchLiftError(`Snapshot already exists: ${name}`, "Choose a new name; snapshots are immutable.");
    }
    const parent = dirname(finalPath);
    await mkdir(parent, { recursive: true });
    const buildId = randomUUID().slice(0, 8);
    const staging = join(parent, `.building-${safeSlug(name)}-${buildId}`);
    const volumeRoot = join(staging, "volumes");
    await mkdir(volumeRoot, { recursive: true });

    const composeFiles = config.compose.files.map((file) => resolve(repo.root, file));
    const primaryComposeFile = config.compose.files[0];
    if (primaryComposeFile === undefined) throw new BranchLiftError("At least one Compose file is required.");
    const sourceRuntime: SourceComposeRuntime = {
      cwd: repo.root,
      composeFiles,
      ...(sourceProject === undefined ? {} : { project: sourceProject }),
      ...(session.envFile === undefined ? {} : { envFile: session.envFile }),
    };
    const uniqueVolumes = [...new Map(inspection.volumes.map((volume) => [volume.source, volume])).values()];
    const metadata: SnapshotMetadata = {
      version: 1,
      name,
      repoKey: repo.key,
      sourceRoot: repo.root,
      composeFile: primaryComposeFile,
      composeFiles: config.compose.files,
      composeProject: projectName(repo, `import-${name}`),
      importedFromProject: sourceProject ?? "compose-default",
      postgresDataDirectories: Object.fromEntries(
        inspection.postgresServices.map((service) => [service, inspection.postgresDataDirectories[service] ?? false]),
      ),
      ...(inspection.mysqlServices.length === 0
        ? {}
        : { mysqlLowerCaseTableNames: importedMySqlLowerCaseTableNames(inspection) }),
      createdAt: new Date().toISOString(),
      status: "building",
      volumeNames: uniqueVolumes.map((volume) => volume.source).sort(),
    };
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);

    let runningServices: string[] = [];
    let sourceStopped = false;
    try {
      runningServices = await adapter.runningServices(sourceRuntime);
      if (runningServices.length > 0) {
        await adapter.stop(sourceRuntime, runningServices);
        sourceStopped = true;
      }
      for (const volume of uniqueVolumes) {
        const destination = join(volumeRoot, volumeDirectoryName(volume.source));
        await mkdir(destination, { recursive: true });
        await adapter.copy(sourceRuntime, volume, destination);
      }
      if (sourceStopped) {
        await adapter.start(sourceRuntime, runningServices);
        sourceStopped = false;
      }
      metadata.status = "ready";
      metadata.completedAt = new Date().toISOString();
      metadata.sizeBytes = await directorySize(volumeRoot);
      await makeTreeReadOnly(volumeRoot);
      const manifest = await createSnapshotManifest(name, volumeRoot, metadata.volumeNames);
      await writeSnapshotManifest(staging, manifest);
      metadata.contentDigest = manifest.digest;
      metadata.manifestFile = "manifest.json";
      metadata.fileCount = manifest.entries.length;
      await writeJsonAtomic(join(staging, "metadata.json"), metadata);
      await rename(staging, finalPath);
      return { metadata, path: finalPath };
    } catch (error) {
      let restartError: unknown;
      if (sourceStopped) {
        try {
          await adapter.start(sourceRuntime, runningServices);
        } catch (caught) {
          restartError = caught;
        }
      }
      metadata.status = "failed";
      const primaryError = await redactEnvFileText(session.envFile, errorDetail(error));
      const restartDetail = restartError === undefined ? undefined : await redactEnvFileText(session.envFile, errorDetail(restartError));
      metadata.error = [primaryError, restartDetail === undefined ? undefined : `Source restart failed: ${restartDetail}`]
        .filter(Boolean)
        .join("\n");
      await writeJsonAtomic(join(staging, "metadata.json"), metadata);
      const failedPath = join(parent, `.failed-${safeSlug(name)}-${Date.now()}`);
      await rename(staging, failedPath);
      throw new BranchLiftError(`Snapshot import failed. Diagnostic state kept at ${failedPath}`, metadata.error);
    }
      });
    } finally {
      await session.close();
    }
  })();
  await recordEventBestEffort(repo, "snapshot.import", `Imported immutable snapshot ${name}.`, {
    snapshot: name,
    details: { sourceProject: sourceProject ?? "compose-default", logicalBytes: result.metadata.sizeBytes ?? 0 },
  });
  return result;
}

export async function commitSnapshotFromInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
  branch: string,
): Promise<SnapshotResult> {
  await assertSecurityPolicyTrusted(repo, config);
  const result = await withLock(repo, instanceLockScope(branch), "snapshot commit", async () => {
    return await withLock(repo, snapshotLockScope(name), "snapshot commit", async () => {
      return await commitSnapshotFromInstanceUnlocked(repo, config, inspection, name, branch);
    });
  });
  await recordEventBestEffort(repo, "snapshot.commit", `Committed backend state from ${branch} as ${name}.`, {
    branch,
    snapshot: name,
    details: { parent: result.metadata.parentSnapshot, digest: result.metadata.contentDigest },
  });
  return result;
}

async function commitSnapshotFromInstanceUnlocked(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
  branch: string,
): Promise<SnapshotResult> {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely cloneable.", inspection.blockers.join("\n"));
  }
  const instance = await readInstanceMetadata(repo, safeSlug(branch));
  if (instance.status !== "running" && instance.status !== "stopped") {
    throw new BranchLiftError(`Instance ${branch} is ${instance.status}; only running or stopped state can be committed.`);
  }
  if (instance.volumeRoot === undefined || !(await pathExists(instance.volumeRoot))) {
    throw new BranchLiftError(`Instance state directory is missing for ${branch}.`);
  }
  const parentMetadata = await readSnapshotMetadata(repo, instance.snapshot);
  const finalPath = snapshotRoot(repo, name);
  if (await pathExists(finalPath)) throw new BranchLiftError(`Snapshot already exists: ${name}`, "Snapshots are immutable; choose a new name.");
  const parent = dirname(finalPath);
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.building-${safeSlug(name)}-${randomUUID().slice(0, 8)}`);
  const volumeRoot = join(staging, "volumes");
  await mkdir(volumeRoot, { recursive: true });
  const now = new Date().toISOString();
  const metadata: SnapshotMetadata = {
    version: 1,
    name,
    repoKey: repo.key,
    sourceRoot: repo.root,
    composeFile: instance.composeFile,
    composeFiles: instance.composeFiles ?? [instance.composeFile],
    composeProject: projectName(repo, `commit-${name}`),
    createdAt: now,
    status: "building",
    volumeNames: parentMetadata.volumeNames,
    parentSnapshot: instance.snapshot,
    sourceInstance: branch,
    ...(parentMetadata.postgresDataDirectories === undefined ? {} : { postgresDataDirectories: parentMetadata.postgresDataDirectories }),
    ...(parentMetadata.mysqlLowerCaseTableNames === undefined ? {} : { mysqlLowerCaseTableNames: parentMetadata.mysqlLowerCaseTableNames }),
  };
  await writeJsonAtomic(join(staging, "metadata.json"), metadata);
  const wasRunning = instance.status === "running";
  const runtime = runtimeForInstance(instance);
  let sourceRestored = !wasRunning;
  try {
    if (wasRunning) {
      await normalizeRuntimeStateOwnership(runtime, instance.managedVolumes ?? inspection.volumes, instance.volumeRoot);
      await composeDownBestEffort(runtime);
    }
    const strategies = await Promise.all(metadata.volumeNames.map(async (volume) => {
      const source = join(instance.volumeRoot as string, volumeDirectoryName(volume));
      if (!(await pathExists(source))) throw new BranchLiftError(`Instance volume is missing: ${volume}`);
      return await cloneDirectory(source, join(volumeRoot, volumeDirectoryName(volume)));
    }));
    metadata.copyStrategy = strategies.reduce(mergeCopyStrategies, "empty" as CopyStrategy);
    if (wasRunning) {
      await restoreCommittedInstance(repo, config, inspection, instance, runtime);
      sourceRestored = true;
    }
    metadata.status = "ready";
    metadata.completedAt = new Date().toISOString();
    metadata.sizeBytes = await directorySize(volumeRoot);
    await makeTreeReadOnly(volumeRoot);
    const manifest = await createSnapshotManifest(name, volumeRoot, metadata.volumeNames);
    await writeSnapshotManifest(staging, manifest);
    metadata.contentDigest = manifest.digest;
    metadata.manifestFile = "manifest.json";
    metadata.fileCount = manifest.entries.length;
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    await rename(staging, finalPath);
    return { metadata, path: finalPath };
  } catch (error) {
    let restoreError: unknown;
    if (wasRunning && !sourceRestored) {
      try {
        await restoreCommittedInstance(repo, config, inspection, instance, runtime);
      } catch (caught) {
        restoreError = caught;
        instance.status = "failed";
        instance.ports = [];
        instance.error = await redactInstanceText(repo, instance.slug, errorDetail(caught)).catch(() => "Instance restore failed; diagnostic redaction was unavailable.");
        instance.updatedAt = new Date().toISOString();
        await writeInstanceMetadata(repo, instance.slug, instance);
        await writeJsonAtomic(join(instanceRoot(repo, instance.slug), "context.json"), instanceContextRecord(instance));
      }
    }
    metadata.status = "failed";
    const primaryError = await redactInstanceText(repo, instance.slug, errorDetail(error)).catch(() => "Snapshot commit failed; diagnostic redaction was unavailable.");
    const restoreDetail = restoreError === undefined
      ? undefined
      : await redactInstanceText(repo, instance.slug, errorDetail(restoreError)).catch(() => "Source restart failed; diagnostic redaction was unavailable.");
    metadata.error = [primaryError, restoreDetail === undefined ? undefined : `Source restart failed: ${restoreDetail}`]
      .filter(Boolean)
      .join("\n");
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    const failedPath = join(parent, `.failed-${safeSlug(name)}-${Date.now()}`);
    await rename(staging, failedPath);
    throw new BranchLiftError(`Snapshot commit failed. Diagnostic state kept at ${failedPath}`, metadata.error);
  }
}

async function restoreCommittedInstance(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  instance: InstanceMetadata,
  runtime: ReturnType<typeof runtimeForInstance>,
): Promise<void> {
  await composeUp(runtime, config.snapshot.healthTimeoutSeconds, true, inspection.volumes, instance.volumeRoot);
  instance.ports = await publishedPorts(runtime, inspection);
  instance.status = "running";
  delete instance.error;
  instance.updatedAt = new Date().toISOString();
  await writeInstanceMetadata(repo, instance.slug, instance);
  await writeJsonAtomic(join(instanceRoot(repo, instance.slug), "context.json"), instanceContextRecord(instance));
}

function runtimeForInstance(instance: InstanceMetadata) {
  return {
    cwd: instance.worktreePath,
    composeFiles: (instance.composeFiles ?? [instance.composeFile]).map((file) => resolve(instance.worktreePath, file)),
    overrideFile: instance.overrideFile,
    project: instance.composeProject,
    ...(instance.secretEnvFile === undefined ? {} : { envFile: instance.secretEnvFile }),
  };
}

function instanceContextRecord(instance: InstanceMetadata): Record<string, unknown> {
  return {
    instance: instance.id,
    branch: instance.branch,
    worktree: instance.worktreePath,
    composeProject: instance.composeProject,
    snapshot: instance.snapshot,
    ports: instance.ports,
  };
}

function mergeCopyStrategies(current: CopyStrategy, next: CopyStrategy): CopyStrategy {
  const rank: Record<CopyStrategy, number> = { empty: 0, "apfs-clone": 1, "linux-reflink": 1, "recursive-copy": 2 };
  return rank[next] > rank[current] ? next : current;
}

async function createSnapshotUnlocked(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
  envFile?: string,
): Promise<SnapshotResult> {
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError(
      "Compose project is not safely cloneable.",
      inspection.blockers.map((blocker) => `- ${blocker}`).join("\n"),
    );
  }
  if (config.compose.statefulServices.length === 0 || inspection.volumes.length === 0) {
    throw new BranchLiftError("No stateful services with named volumes were found.");
  }

  await assertDockerReady();
  const finalPath = snapshotRoot(repo, name);
  if (await pathExists(finalPath)) {
    throw new BranchLiftError(`Snapshot already exists: ${name}`, "Choose a new name; snapshots are immutable.");
  }

  const parent = dirname(finalPath);
  await mkdir(parent, { recursive: true });
  const buildId = randomUUID().slice(0, 8);
  const staging = join(parent, `.building-${safeSlug(name)}-${buildId}`);
  const volumeRoot = join(staging, "volumes");
  const project = projectName(repo, `snapshot-${name}`);
  // Build every managed volume in Docker-native storage first. Besides giving
  // databases their expected filesystem semantics during initialization, the
  // subsequent `docker cp` export makes the immutable snapshot host-owned.
  // Direct bind bootstrap can otherwise leave files owned by an image user
  // (Redis commonly does this), making snapshot cleanup fail on Linux.
  const nativeExports = [...new Map(inspection.volumes.map((volume) => [volume.source, volume])).values()];
  const nativeVolumes = new Map(
    nativeExports.map((volume) => [
      volume.source,
      `${project}-${volumeDirectoryName(volume.source)}-${buildId}`,
    ]),
  );
  await mkdir(volumeRoot, { recursive: true });
  for (const volume of new Set(inspection.volumes.map((item) => item.source))) {
    await mkdir(join(volumeRoot, volumeDirectoryName(volume)), { recursive: true });
  }
  for (const volume of nativeExports) {
    await rm(join(volumeRoot, volumeDirectoryName(volume.source)), { recursive: true, force: true });
  }
  const overrideFile = join(staging, "snapshot.override.yaml");
  await writeFile(
    overrideFile,
    generateOverride(
      inspection,
      volumeRoot,
      nativeVolumes.size > 0
        ? {
            randomizePorts: true,
            nativeVolumes,
            postgresHostUser: false,
            mysqlHostUser: false,
            mysqlLowerCaseTableNames: 1,
          }
        : { randomizePorts: true },
    ),
  );
  const composeFiles = config.compose.files.map((file) => resolve(repo.root, file));
  const primaryComposeFile = config.compose.files[0];
  if (primaryComposeFile === undefined) throw new BranchLiftError("At least one Compose file is required.");
  const runtime = { cwd: repo.root, composeFiles, overrideFile, project, ...(envFile === undefined ? {} : { envFile }) };
  const metadata: SnapshotMetadata = {
    version: 1,
    name,
    repoKey: repo.key,
    sourceRoot: repo.root,
    composeFile: primaryComposeFile,
    composeFiles: config.compose.files,
    composeProject: project,
    createdAt: new Date().toISOString(),
    status: "building",
    volumeNames: [...new Set(inspection.volumes.map((item) => item.source))].sort(),
    postgresDataDirectories: Object.fromEntries(
      inspection.postgresServices.flatMap((service) => {
        const dataVolume = inspection.volumes.find((volume) => volume.service === service);
        return dataVolume === undefined ? [] : [[service, `${dataVolume.target}/.branchlift-pgdata`] as const];
      }),
    ),
    ...(inspection.mysqlServices.length === 0 ? {} : { mysqlLowerCaseTableNames: 1 }),
  };
  await writeJsonAtomic(join(staging, "metadata.json"), metadata);

  let started = false;
  try {
    await validateCompose(runtime);
    await composeUp(runtime, config.snapshot.healthTimeoutSeconds);
    started = true;
    for (const seed of config.snapshot.seed) {
      await composeSeed(runtime, seed.service, seed.command);
    }
    if (nativeVolumes.size > 0) {
      await composeStop(runtime);
      for (const volume of nativeExports) {
        const destination = join(volumeRoot, volumeDirectoryName(volume.source));
        await mkdir(destination, { recursive: true });
        await copyServicePathToHost(runtime, volume.service, volume.target, destination);
      }
    }
    await composeDown(runtime);
    started = false;
    await removeDockerVolumes(nativeVolumes.values());
    metadata.status = "ready";
    metadata.completedAt = new Date().toISOString();
    metadata.sizeBytes = await directorySize(volumeRoot);
    await makeTreeReadOnly(volumeRoot);
    const manifest = await createSnapshotManifest(name, volumeRoot, metadata.volumeNames);
    await writeSnapshotManifest(staging, manifest);
    metadata.contentDigest = manifest.digest;
    metadata.manifestFile = "manifest.json";
    metadata.fileCount = manifest.entries.length;
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    await rename(staging, finalPath);
    return { metadata, path: finalPath };
  } catch (error) {
    if (started) await composeDownBestEffort(runtime);
    await removeDockerVolumes(nativeVolumes.values(), true);
    metadata.status = "failed";
    metadata.error = await redactEnvFileText(envFile, errorDetail(error));
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    const failedPath = join(parent, `.failed-${safeSlug(name)}-${Date.now()}`);
    await rename(staging, failedPath);
    throw new BranchLiftError(`Snapshot creation failed. Diagnostic state kept at ${failedPath}`, metadata.error);
  }
}

export function projectName(repo: RepoInfo, suffix: string): string {
  return `bl-${repo.key.slice(-12)}-${safeSlug(suffix)}`.slice(0, 63);
}

function importedMySqlLowerCaseTableNames(inspection: ComposeInspection): 0 | 1 | 2 {
  for (const service of inspection.mysqlServices) {
    const command = inspection.serviceCommands[service];
    const serialized = Array.isArray(command) ? command.join(" ") : command ?? "";
    const match = /--lower-case-table-names(?:=|\s+)([012])(?:\s|$)/.exec(serialized);
    if (match?.[1] === "1") return 1;
    if (match?.[1] === "2") return 2;
    if (match?.[1] === "0") return 0;
  }
  return 0;
}
