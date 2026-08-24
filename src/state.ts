import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { instanceRoot, pathExists, readJson, repoDataRoot, snapshotRoot, writeJsonAtomic } from "./paths.js";
import type { InstanceMetadata, RepoInfo, SnapshotMetadata } from "./types.js";
import { BranchLiftError } from "./errors.js";

const metadataFile = "metadata.json";

export async function writeSnapshotMetadata(repo: RepoInfo, name: string, metadata: SnapshotMetadata): Promise<void> {
  await writeJsonAtomic(join(snapshotRoot(repo, name), metadataFile), metadata);
}

export async function readSnapshotMetadata(repo: RepoInfo, name: string): Promise<SnapshotMetadata> {
  const path = join(snapshotRoot(repo, name), metadataFile);
  if (!(await pathExists(path))) throw new BranchLiftError(`Snapshot not found: ${name}`, "Run branchlift snapshot first.");
  return await readJson<SnapshotMetadata>(path);
}

export async function writeInstanceMetadata(repo: RepoInfo, slug: string, metadata: InstanceMetadata): Promise<void> {
  await writeJsonAtomic(join(instanceRoot(repo, slug), metadataFile), metadata);
}

export async function readInstanceMetadata(repo: RepoInfo, slug: string): Promise<InstanceMetadata> {
  const path = join(instanceRoot(repo, slug), metadataFile);
  if (!(await pathExists(path))) throw new BranchLiftError(`Instance not found: ${slug}`);
  return await readJson<InstanceMetadata>(path);
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
      instances.push(await readJson<InstanceMetadata>(path));
    } catch {
      // A partial runtime must not make `list` unusable.
    }
  }
  return instances.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
