import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { instanceRoot, pathExists, readJson, repoDataRoot, snapshotRoot, writeJsonAtomic } from "./paths.js";
import type { InstanceMetadata, RepoInfo, SnapshotMetadata } from "./types.js";
import { BranchLiftError } from "./errors.js";
import { snapshotLockScope, withLock } from "./lock.js";

const metadataFile = "metadata.json";

export async function writeSnapshotMetadata(repo: RepoInfo, name: string, metadata: SnapshotMetadata): Promise<void> {
  await writeJsonAtomic(join(snapshotRoot(repo, name), metadataFile), metadata);
}

export async function readSnapshotMetadata(repo: RepoInfo, name: string): Promise<SnapshotMetadata> {
  const path = join(snapshotRoot(repo, name), metadataFile);
  if (!(await pathExists(path))) throw new BranchLiftError(`Snapshot not found: ${name}`, "Run branchlift snapshot first.");
  const metadata = await readJson<unknown>(path);
  if (!isSnapshotMetadata(metadata)) throw new BranchLiftError(`Snapshot metadata is invalid: ${path}`, "Run branchlift doctor.");
  return metadata;
}

export async function writeInstanceMetadata(repo: RepoInfo, slug: string, metadata: InstanceMetadata): Promise<void> {
  await writeJsonAtomic(join(instanceRoot(repo, slug), metadataFile), metadata);
}

export async function readInstanceMetadata(repo: RepoInfo, slug: string): Promise<InstanceMetadata> {
  const path = join(instanceRoot(repo, slug), metadataFile);
  if (!(await pathExists(path))) throw new BranchLiftError(`Instance not found: ${slug}`);
  const metadata = await readJson<unknown>(path);
  if (!isInstanceMetadata(metadata)) throw new BranchLiftError(`Instance metadata is invalid: ${path}`, "Run branchlift doctor.");
  return metadata;
}

export async function listInstances(repo: RepoInfo): Promise<InstanceMetadata[]> {
  const root = join(repoDataRoot(repo), "instances");
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const instances: InstanceMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, metadataFile);
    if (!(await pathExists(path))) continue;
    try {
      const metadata = await readJson<unknown>(path);
      if (isInstanceMetadata(metadata)) instances.push(metadata);
    } catch {
      // A partial runtime must not make `list` unusable.
    }
  }
  return instances.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listSnapshots(repo: RepoInfo): Promise<SnapshotMetadata[]> {
  const root = join(repoDataRoot(repo), "snapshots");
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const snapshots: SnapshotMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name, metadataFile);
    if (!(await pathExists(path))) continue;
    try {
      const metadata = await readJson<unknown>(path);
      if (isSnapshotMetadata(metadata)) snapshots.push(metadata);
    } catch {
      // A corrupt snapshot is reported by doctor without breaking list.
    }
  }
  return snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function deleteSnapshot(repo: RepoInfo, name: string): Promise<void> {
  await withLock(repo, snapshotLockScope(name), "snapshot delete", async () => {
    await deleteSnapshotUnlocked(repo, name);
  });
}

async function deleteSnapshotUnlocked(repo: RepoInfo, name: string): Promise<void> {
  await readSnapshotMetadata(repo, name);
  const dependants = (await listInstancesStrict(repo)).filter((instance) => instance.snapshot === name);
  if (dependants.length > 0) {
    throw new BranchLiftError(
      `Snapshot ${name} is still used by ${dependants.length} instance(s).`,
      dependants.map((instance) => `- ${instance.branch} (${instance.status})`).join("\n"),
    );
  }

  const root = snapshotRoot(repo, name);
  const parent = resolve(repoDataRoot(repo), "snapshots");
  const resolvedRoot = resolve(root);
  if (!resolvedRoot.startsWith(`${parent}/`)) {
    throw new BranchLiftError(`Refusing to remove a path outside BranchLift snapshots: ${resolvedRoot}`);
  }
  await rm(resolvedRoot, { recursive: true, force: false });
}

async function listInstancesStrict(repo: RepoInfo): Promise<InstanceMetadata[]> {
  const root = join(repoDataRoot(repo), "instances");
  if (!(await pathExists(root))) return [];
  const instances: InstanceMetadata[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, metadataFile);
    try {
      const metadata = await readJson<unknown>(path);
      if (!isInstanceMetadata(metadata)) throw new Error("invalid shape");
      instances.push(metadata);
    } catch {
      throw new BranchLiftError(
        `Cannot prove the snapshot is unused because instance metadata is invalid: ${path}`,
        "Run branchlift doctor and repair or remove the affected instance explicitly before deleting snapshots.",
      );
    }
  }
  return instances;
}

export function isInstanceMetadata(value: unknown): value is InstanceMetadata {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.id === "string"
    && typeof value.branch === "string"
    && typeof value.slug === "string"
    && typeof value.repoKey === "string"
    && typeof value.worktreePath === "string"
    && (value.worktreeOwner === undefined || value.worktreeOwner === "branchlift" || value.worktreeOwner === "external")
    && typeof value.snapshot === "string"
    && typeof value.composeFile === "string"
    && (value.composeFiles === undefined || stringArray(value.composeFiles))
    && typeof value.overrideFile === "string"
    && (value.volumeRoot === undefined || typeof value.volumeRoot === "string")
    && typeof value.composeProject === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && ["creating", "running", "stopped", "failed"].includes(String(value.status))
    && Array.isArray(value.ports);
}

export function isSnapshotMetadata(value: unknown): value is SnapshotMetadata {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.name === "string"
    && typeof value.repoKey === "string"
    && typeof value.composeFile === "string"
    && (value.composeFiles === undefined || stringArray(value.composeFiles))
    && typeof value.composeProject === "string"
    && typeof value.createdAt === "string"
    && ["building", "ready", "failed"].includes(String(value.status))
    && stringArray(value.volumeNames);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
