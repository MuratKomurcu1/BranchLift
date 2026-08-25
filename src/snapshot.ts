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
  sourceRunningServices,
  startSourceServices,
  stopSourceServices,
  validateCompose,
} from "./docker.js";
import { BranchLiftError, errorDetail } from "./errors.js";
import { snapshotLockScope, withLock } from "./lock.js";
import { directorySize, pathExists, safeSlug, snapshotRoot, writeJsonAtomic } from "./paths.js";
import type { SourceComposeRuntime } from "./docker.js";
import type { ComposeInspection, BranchLiftConfig, RepoInfo, SnapshotMetadata, VolumeBinding } from "./types.js";

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
  return await withLock(repo, snapshotLockScope(name), "snapshot create", async () => {
    return await createSnapshotUnlocked(repo, config, inspection, name);
  });
}

export async function importSnapshot(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
  sourceProject?: string,
  adapter: SnapshotImportAdapter = dockerImportAdapter,
): Promise<SnapshotResult> {
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
      metadata.error = [errorDetail(error), restartError === undefined ? undefined : `Source restart failed: ${errorDetail(restartError)}`]
        .filter(Boolean)
        .join("\n");
      await writeJsonAtomic(join(staging, "metadata.json"), metadata);
      const failedPath = join(parent, `.failed-${safeSlug(name)}-${Date.now()}`);
      await rename(staging, failedPath);
      throw new BranchLiftError(`Snapshot import failed. Diagnostic state kept at ${failedPath}`, metadata.error);
    }
  });
}

async function createSnapshotUnlocked(
  repo: RepoInfo,
  config: BranchLiftConfig,
  inspection: ComposeInspection,
  name: string,
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
  const runtime = { cwd: repo.root, composeFiles, overrideFile, project };
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
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    await rename(staging, finalPath);
    return { metadata, path: finalPath };
  } catch (error) {
    if (started) await composeDownBestEffort(runtime);
    await removeDockerVolumes(nativeVolumes.values(), true);
    metadata.status = "failed";
    metadata.error = errorDetail(error);
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
