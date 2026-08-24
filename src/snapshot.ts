import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { generateOverride, volumeDirectoryName } from "./compose.js";
import { assertDockerReady, composeDown, composeDownBestEffort, composeSeed, composeUp, validateCompose } from "./docker.js";
import { BranchLiftError } from "./errors.js";
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
  const staging = join(parent, `.building-${safeSlug(name)}-${randomUUID().slice(0, 8)}`);
  const volumeRoot = join(staging, "volumes");
  await mkdir(volumeRoot, { recursive: true });
  for (const volume of new Set(inspection.volumes.map((item) => item.source))) {
    await mkdir(join(volumeRoot, volumeDirectoryName(volume)), { recursive: true });
  }

  const overrideFile = join(staging, "snapshot.override.yaml");
  await writeFile(overrideFile, generateOverride(inspection, volumeRoot, { randomizePorts: true }));
  const composeFiles = config.compose.files.map((file) => resolve(repo.root, file));
  const primaryComposeFile = config.compose.files[0];
  if (primaryComposeFile === undefined) throw new BranchLiftError("At least one Compose file is required.");
  const project = projectName(repo, `snapshot-${name}`);
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
    await composeDown(runtime);
    started = false;
    metadata.status = "ready";
    metadata.completedAt = new Date().toISOString();
    metadata.sizeBytes = await directorySize(volumeRoot);
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    await rename(staging, finalPath);
    return { metadata, path: finalPath };
  } catch (error) {
    if (started) await composeDownBestEffort(runtime);
    metadata.status = "failed";
    metadata.error = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(join(staging, "metadata.json"), metadata);
    const failedPath = join(parent, `.failed-${safeSlug(name)}-${Date.now()}`);
    await rename(staging, failedPath);
    throw new BranchLiftError(`Snapshot creation failed. Diagnostic state kept at ${failedPath}`, metadata.error);
  }
}

export function projectName(repo: RepoInfo, suffix: string): string {
  return `bl-${repo.key.slice(-12)}-${safeSlug(suffix)}`.slice(0, 63);
}
