import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { generateOverride, postgresDataVolumes, volumeDirectoryName } from "./compose.js";
import {
  assertDockerReady,
  composeDown,
  composeDownBestEffort,
  composeSeed,
  composeStop,
  composeUp,
  copyServicePathToHost,
  removeDockerVolumes,
  validateCompose,
} from "./docker.js";
import { BranchLiftError, errorDetail } from "./errors.js";
import { snapshotLockScope, withLock } from "./lock.js";
import { directorySize, pathExists, safeSlug, snapshotRoot, writeJsonAtomic } from "./paths.js";
import type { ComposeInspection, BranchLiftConfig, RepoInfo, SnapshotMetadata } from "./types.js";

export interface SnapshotResult {
  metadata: SnapshotMetadata;
  path: string;
}

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
  const nativeExports = process.platform === "darwin"
    ? [...new Map(postgresDataVolumes(inspection).map((volume) => [volume.source, volume])).values()]
    : [];
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
  for (const volume of postgresDataVolumes(inspection)) {
    if (nativeVolumes.has(volume.source)) continue;
    await mkdir(join(volumeRoot, volumeDirectoryName(volume.source), ".branchlift-pgdata"), { recursive: true });
  }

  const overrideFile = join(staging, "snapshot.override.yaml");
  await writeFile(
    overrideFile,
    generateOverride(
      inspection,
      volumeRoot,
      nativeVolumes.size > 0
        ? { randomizePorts: true, nativeVolumes, postgresHostUser: false }
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
