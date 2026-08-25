import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { volumeDirectoryName } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import { snapshotLockScope, withLock } from "./lock.js";
import { pathExists, readJson, snapshotRoot, writeJsonAtomic } from "./paths.js";
import { readSnapshotMetadata, writeSnapshotMetadata } from "./state.js";
import type { RepoInfo, SnapshotManifest, SnapshotManifestEntry } from "./types.js";

const manifestFileName = "manifest.json";
const hashConcurrency = 8;

interface ManifestCandidate {
  volume: string;
  path: string;
  absolutePath: string;
  kind: SnapshotManifestEntry["kind"];
  size: number;
  mode: number;
}

export interface SnapshotDiffEntry {
  volume: string;
  path: string;
  kind: "added" | "removed" | "modified";
  before?: { digest: string; size: number; type: SnapshotManifestEntry["kind"] };
  after?: { digest: string; size: number; type: SnapshotManifestEntry["kind"] };
}

export interface SnapshotDiff {
  left: { name: string; digest: string; logicalBytes: number; files: number };
  right: { name: string; digest: string; logicalBytes: number; files: number };
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  sharedContentBytes: number;
  entries: SnapshotDiffEntry[];
}

export async function createSnapshotManifest(
  snapshot: string,
  volumeRoot: string,
  volumeNames: string[],
): Promise<SnapshotManifest> {
  const candidates: ManifestCandidate[] = [];
  for (const volume of [...volumeNames].sort()) {
    const root = join(volumeRoot, volumeDirectoryName(volume));
    if (!(await pathExists(root))) throw new BranchLiftError(`Snapshot volume directory is missing: ${volume}`);
    await collectCandidates(volume, root, root, candidates);
  }
  candidates.sort((left, right) => `${left.volume}\0${left.path}`.localeCompare(`${right.volume}\0${right.path}`));
  const entries = await mapLimit(candidates, hashConcurrency, async (candidate): Promise<SnapshotManifestEntry> => ({
    volume: candidate.volume,
    path: candidate.path,
    kind: candidate.kind,
    size: candidate.size,
    mode: candidate.mode,
    digest: await candidateDigest(candidate),
  }));
  const digest = createHash("sha256");
  for (const entry of entries) digest.update(`${entry.volume}\0${entry.path}\0${entry.kind}\0${entry.size}\0${entry.mode}\0${entry.digest}\n`);
  return {
    version: 1,
    snapshot,
    createdAt: new Date().toISOString(),
    digest: `sha256:${digest.digest("hex")}`,
    logicalBytes: entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0),
    entries,
  };
}

export async function writeSnapshotManifest(snapshotPath: string, manifest: SnapshotManifest): Promise<void> {
  await writeJsonAtomic(join(snapshotPath, manifestFileName), manifest);
}

export async function ensureSnapshotManifest(repo: RepoInfo, name: string): Promise<SnapshotManifest> {
  return await withLock(repo, snapshotLockScope(name), "snapshot manifest", async () => {
    const metadata = await readSnapshotMetadata(repo, name);
    if (metadata.status !== "ready") throw new BranchLiftError(`Snapshot is not ready: ${name}`);
    const root = snapshotRoot(repo, name);
    const path = join(root, metadata.manifestFile ?? manifestFileName);
    if (await pathExists(path)) {
      const manifest = await readJson<unknown>(path);
      if (isSnapshotManifest(manifest, name)) return manifest;
      throw new BranchLiftError(`Snapshot manifest is invalid: ${path}`);
    }
    const manifest = await createSnapshotManifest(name, join(root, "volumes"), metadata.volumeNames);
    await writeSnapshotManifest(root, manifest);
    metadata.contentDigest = manifest.digest;
    metadata.manifestFile = manifestFileName;
    metadata.fileCount = manifest.entries.length;
    await writeSnapshotMetadata(repo, name, metadata);
    return manifest;
  });
}

export async function verifySnapshotContent(
  repo: RepoInfo,
  name: string,
  expectedDigest: string,
  expectedVolumeNames?: string[],
): Promise<SnapshotManifest> {
  const metadata = await readSnapshotMetadata(repo, name);
  if (metadata.status !== "ready") throw new BranchLiftError(`Snapshot is not ready: ${name}`);
  if (metadata.contentDigest !== expectedDigest) {
    throw new BranchLiftError(`Snapshot ${name} metadata does not match the expected content digest.`);
  }
  const volumeNames = expectedVolumeNames ?? metadata.volumeNames;
  const actual = await createSnapshotManifest(name, join(snapshotRoot(repo, name), "volumes"), volumeNames);
  if (actual.digest !== expectedDigest) {
    throw new BranchLiftError(
      `Snapshot ${name} failed content integrity verification.`,
      `Expected ${expectedDigest}; computed ${actual.digest}.`,
    );
  }
  return actual;
}

export async function diffSnapshots(repo: RepoInfo, leftName: string, rightName: string): Promise<SnapshotDiff> {
  if (leftName === rightName) throw new BranchLiftError("Snapshot diff requires two different snapshot names.");
  const left = await ensureSnapshotManifest(repo, leftName);
  const right = await ensureSnapshotManifest(repo, rightName);
  const leftMap = new Map(left.entries.map((entry) => [entryKey(entry), entry]));
  const rightMap = new Map(right.entries.map((entry) => [entryKey(entry), entry]));
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const entries: SnapshotDiffEntry[] = [];
  let unchanged = 0;
  let sharedContentBytes = 0;
  for (const key of keys) {
    const before = leftMap.get(key);
    const after = rightMap.get(key);
    if (before === undefined && after !== undefined) {
      entries.push({ volume: after.volume, path: after.path, kind: "added", after: summary(after) });
    } else if (before !== undefined && after === undefined) {
      entries.push({ volume: before.volume, path: before.path, kind: "removed", before: summary(before) });
    } else if (before !== undefined && after !== undefined) {
      if (before.digest === after.digest && before.kind === after.kind && before.mode === after.mode) {
        unchanged += 1;
        if (before.kind === "file") sharedContentBytes += Math.min(before.size, after.size);
      } else {
        entries.push({ volume: after.volume, path: after.path, kind: "modified", before: summary(before), after: summary(after) });
      }
    }
  }
  return {
    left: { name: left.snapshot, digest: left.digest, logicalBytes: left.logicalBytes, files: left.entries.length },
    right: { name: right.snapshot, digest: right.digest, logicalBytes: right.logicalBytes, files: right.entries.length },
    added: entries.filter(({ kind }) => kind === "added").length,
    removed: entries.filter(({ kind }) => kind === "removed").length,
    modified: entries.filter(({ kind }) => kind === "modified").length,
    unchanged,
    sharedContentBytes,
    entries,
  };
}

async function collectCandidates(
  volume: string,
  root: string,
  current: string,
  output: ManifestCandidate[],
): Promise<void> {
  const currentInfo = await lstat(current);
  if (current !== root) {
    output.push({
      volume,
      path: portablePath(relative(root, current)),
      absolutePath: current,
      kind: currentInfo.isSymbolicLink() ? "symlink" : currentInfo.isDirectory() ? "directory" : "file",
      size: currentInfo.isFile() ? currentInfo.size : currentInfo.isSymbolicLink() ? Buffer.byteLength(await readlink(current)) : 0,
      mode: currentInfo.mode & 0o7777,
    });
  }
  if (!currentInfo.isDirectory()) return;
  const children = await readdir(current);
  for (const child of children.sort()) await collectCandidates(volume, root, join(current, child), output);
}

async function candidateDigest(candidate: ManifestCandidate): Promise<string> {
  const hash = createHash("sha256");
  if (candidate.kind === "file") {
    for await (const chunk of createReadStream(candidate.absolutePath)) hash.update(chunk as Buffer);
  } else if (candidate.kind === "symlink") hash.update(await readlink(candidate.absolutePath));
  else hash.update("directory");
  return `sha256:${hash.digest("hex")}`;
}

function entryKey(entry: Pick<SnapshotManifestEntry, "volume" | "path">): string {
  return `${entry.volume}\0${entry.path}`;
}

function summary(entry: SnapshotManifestEntry): { digest: string; size: number; type: SnapshotManifestEntry["kind"] } {
  return { digest: entry.digest, size: entry.size, type: entry.kind };
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

async function mapLimit<T, R>(items: T[], limit: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) results[index] = await operation(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function isSnapshotManifest(value: unknown, expectedName: string): value is SnapshotManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1
    && item.snapshot === expectedName
    && typeof item.createdAt === "string"
    && typeof item.digest === "string"
    && typeof item.logicalBytes === "number"
    && Array.isArray(item.entries)
    && item.entries.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)
      && typeof (entry as Record<string, unknown>).volume === "string"
      && typeof (entry as Record<string, unknown>).path === "string"
      && ["file", "directory", "symlink"].includes(String((entry as Record<string, unknown>).kind))
      && typeof (entry as Record<string, unknown>).size === "number"
      && typeof (entry as Record<string, unknown>).mode === "number"
      && typeof (entry as Record<string, unknown>).digest === "string");
}
