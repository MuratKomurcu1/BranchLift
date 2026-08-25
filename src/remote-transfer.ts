import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream, watch as watchFs } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Writable } from "node:stream";
import { volumeDirectoryName } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { discoverRepo } from "./git.js";
import { instanceLockScope, snapshotLockScope, withLock } from "./lock.js";
import { createSnapshotManifest, ensureSnapshotManifest, verifySnapshotContent, writeSnapshotManifest } from "./manifest.js";
import {
  makeTreeReadOnly,
  pathExists,
  readJson,
  repoDataRoot,
  safeSlug,
  snapshotRoot,
  writeJsonAtomic,
} from "./paths.js";
import { runCommand } from "./process.js";
import { callRemote, getRemote, remoteDestination, remoteSshArguments } from "./remote.js";
import { readInstanceMetadata, readSnapshotMetadata } from "./state.js";
import { projectName } from "./snapshot.js";
import type { RemoteDefinition, RepoInfo, SnapshotManifest, SnapshotManifestEntry, SnapshotMetadata } from "./types.js";

const transferProtocol = 1;
const transferResponsePrefix = "BRANCHLIFT-TRANSFER/1 ";
const maximumHeaderBytes = 32 * 1024 * 1024;
const maximumTransferOutputBytes = 1024 * 1024;
const maximumBundleBytes = 5 * 1024 * 1024 * 1024;
const digestPattern = /^sha256:([a-f0-9]{64})$/;
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

interface CodeTransferHeader {
  protocol: 1;
  id: string;
  kind: "code";
  repoPath: string;
  commit: string;
  bundleBytes: number;
  bundleDigest: string;
}

interface SnapshotTransferHeader {
  protocol: 1;
  id: string;
  kind: "snapshot";
  repoPath: string;
  snapshot: string;
  manifest: SnapshotManifest;
  metadata: SnapshotMetadata;
  sentDigests: string[];
  symlinks: Array<{ volume: string; path: string; target: string }>;
}

interface LiveSyncEntry {
  path: string;
  kind: "file" | "symlink";
  size: number;
  mode: number;
  digest: string;
  target?: string;
}

interface LiveSyncManifest {
  version: 1;
  branch: string;
  baseCommit: string;
  generatedAt: string;
  digest: string;
  entries: LiveSyncEntry[];
}

interface LivePlanTransferHeader {
  protocol: 1;
  id: string;
  kind: "live-plan";
  repoPath: string;
  manifest: LiveSyncManifest;
}

interface LiveApplyTransferHeader {
  protocol: 1;
  id: string;
  kind: "live-apply";
  repoPath: string;
  planId: string;
  manifest: LiveSyncManifest;
  sentPaths: string[];
}

interface StoredLivePlan {
  version: 1;
  id: string;
  createdAt: string;
  manifest: LiveSyncManifest;
  missing: string[];
  deletions: string[];
  previousDigest?: string;
}

interface StoredLiveState {
  version: 1;
  appliedAt: string;
  manifest: LiveSyncManifest;
}

type TransferHeader = CodeTransferHeader | SnapshotTransferHeader | LivePlanTransferHeader | LiveApplyTransferHeader;

interface TransferResponse {
  protocol: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface CodeSyncResult {
  remote: string;
  commit: string;
  bundleBytes: number;
  dirtyPathsExcluded: number;
  repository: string;
}

export interface SnapshotPushResult {
  remote: string;
  snapshot: string;
  digest: string;
  logicalBytes: number;
  transferredBytes: number;
  transferredBlobs: number;
  reusedBlobs: number;
  alreadyPresent: boolean;
}

export interface LiveSyncResult {
  remote: string;
  branch: string;
  digest: string;
  files: number;
  transferredFiles: number;
  transferredBytes: number;
  deletedFiles: number;
  alreadyCurrent: boolean;
}

export interface LiveWatchOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  onSync?: (result: LiveSyncResult) => void;
}

export async function syncRemoteCode(repo: RepoInfo, remoteName: string): Promise<CodeSyncResult> {
  const remote = await getRemote(remoteName);
  const commit = (await runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: repo.root })).stdout.trim();
  if (!commitPattern.test(commit)) throw new BranchLiftError("Git returned an unsupported commit identifier.");
  const dirtyOutput = (await runCommand("git", ["status", "--porcelain=v1", "-z"], { cwd: repo.root })).stdout;
  const dirtyPathsExcluded = dirtyOutput === "" ? 0 : dirtyOutput.split("\0").filter(Boolean).length;
  const temporary = await mkdtemp(join(tmpdir(), "branchlift-code-sync-"));
  try {
    const bundlePath = join(temporary, "code.bundle");
    await runCommand("git", ["bundle", "create", bundlePath, "HEAD"], { cwd: repo.root });
    const info = await stat(bundlePath);
    if (info.size <= 0 || info.size > maximumBundleBytes) {
      throw new BranchLiftError(`Git bundle size must be between 1 byte and ${maximumBundleBytes} bytes.`);
    }
    const id = randomUUID();
    const header: CodeTransferHeader = {
      protocol: 1,
      id,
      kind: "code",
      repoPath: remote.repoPath,
      commit,
      bundleBytes: info.size,
      bundleDigest: await hashFile(bundlePath),
    };
    const result = await sendTransfer(remote, id, async (stream) => {
      await writeLine(stream, header);
      await writeFileToStream(stream, bundlePath);
    });
    const repository = isRecord(result) && typeof result.repository === "string" ? result.repository : remote.repoPath;
    const receipt = { remote: remote.name, commit, bundleBytes: info.size, dirtyPathsExcluded, repository };
    await recordEventBestEffort(repo, "remote.code.sync", `Synchronized commit ${commit.slice(0, 12)} to ${remote.name}.`, {
      details: { remote: remote.name, commit, bundleBytes: info.size, dirtyPathsExcluded },
    });
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function pushRemoteSnapshot(repo: RepoInfo, remoteName: string, name: string): Promise<SnapshotPushResult> {
  const remote = await getRemote(remoteName);
  const manifest = await ensureSnapshotManifest(repo, name);
  validateManifest(manifest, name);
  const metadata = await readSnapshotMetadata(repo, name);
  if (metadata.status !== "ready") throw new BranchLiftError(`Snapshot is not ready: ${name}`);
  const uniqueFiles = uniqueFileEntries(manifest);
  const plan = await planRemoteSnapshot(repo, remote.name, name, manifest.digest, [...uniqueFiles.keys()]);
  if (plan.alreadyPresent) {
    return {
      remote: remote.name,
      snapshot: name,
      digest: manifest.digest,
      logicalBytes: manifest.logicalBytes,
      transferredBytes: 0,
      transferredBlobs: 0,
      reusedBlobs: uniqueFiles.size,
      alreadyPresent: true,
    };
  }
  const missing = [...plan.missing].sort();
  const symlinks = await snapshotSymlinks(repo, name, manifest);
  const id = randomUUID();
  const header: SnapshotTransferHeader = {
    protocol: 1,
    id,
    kind: "snapshot",
    repoPath: remote.repoPath,
    snapshot: name,
    manifest,
    metadata,
    sentDigests: missing,
    symlinks,
  };
  const result = await sendTransfer(remote, id, async (stream) => {
    await writeLine(stream, header);
    for (const digest of missing) {
      const entry = uniqueFiles.get(digest);
      if (entry === undefined) throw new BranchLiftError(`Snapshot manifest file is missing for ${digest}.`);
      await writeLine(stream, { digest, size: entry.size });
      await writeFileToStream(stream, snapshotEntryPath(repo, name, entry));
    }
  });
  const transferredBytes = missing.reduce((total, digest) => total + (uniqueFiles.get(digest)?.size ?? 0), 0);
  if (!isRecord(result) || result.digest !== manifest.digest) {
    throw new BranchLiftError(`Remote ${remote.name} returned an invalid snapshot transfer receipt.`);
  }
  const receipt = {
    remote: remote.name,
    snapshot: name,
    digest: manifest.digest,
    logicalBytes: manifest.logicalBytes,
    transferredBytes,
    transferredBlobs: missing.length,
    reusedBlobs: uniqueFiles.size - missing.length,
    alreadyPresent: false,
  };
  await recordEventBestEffort(repo, "remote.snapshot.push", `Pushed snapshot ${name} to ${remote.name}.`, {
    snapshot: name,
    details: { remote: remote.name, digest: manifest.digest, transferredBytes, transferredBlobs: missing.length, reusedBlobs: uniqueFiles.size - missing.length },
  });
  return receipt;
}

export async function syncRemoteWorkingTree(repo: RepoInfo, remoteName: string, branch: string): Promise<LiveSyncResult> {
  const remote = await getRemote(remoteName);
  const manifest = await createLiveSyncManifest(repo, branch);
  const planId = randomUUID();
  const planResult = await sendTransfer(remote, planId, async (stream) => {
    await writeLine(stream, {
      protocol: 1,
      id: planId,
      kind: "live-plan",
      repoPath: remote.repoPath,
      manifest,
    } satisfies LivePlanTransferHeader);
  });
  if (!isRecord(planResult) || typeof planResult.planId !== "string"
    || !Array.isArray(planResult.missing) || !Array.isArray(planResult.deletions)) {
    throw new BranchLiftError(`Remote ${remote.name} returned an invalid live-sync plan.`);
  }
  const planIdentifier = planResult.planId;
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const missing = planResult.missing.map((path) => {
    if (typeof path !== "string" || !entries.has(path)) throw new BranchLiftError(`Remote ${remote.name} requested an invalid live-sync path.`);
    return path;
  });
  const deletions = planResult.deletions.map((path) => {
    if (typeof path !== "string" || !safePortablePath(path)) throw new BranchLiftError(`Remote ${remote.name} returned an invalid live-sync deletion.`);
    return path;
  });
  if (missing.length === 0 && deletions.length === 0) {
    return {
      remote: remote.name,
      branch,
      digest: manifest.digest,
      files: manifest.entries.length,
      transferredFiles: 0,
      transferredBytes: 0,
      deletedFiles: 0,
      alreadyCurrent: true,
    };
  }
  const applyId = randomUUID();
  const result = await sendTransfer(remote, applyId, async (stream) => {
    await writeLine(stream, {
      protocol: 1,
      id: applyId,
      kind: "live-apply",
      repoPath: remote.repoPath,
      planId: planIdentifier,
      manifest,
      sentPaths: missing,
    } satisfies LiveApplyTransferHeader);
    for (const path of missing) {
      const entry = entries.get(path);
      if (entry === undefined || entry.kind !== "file") continue;
      await writeLine(stream, { path, size: entry.size, digest: entry.digest });
      await writeFileToStream(stream, resolveLiveSource(repo, path));
    }
  });
  if (!isRecord(result) || result.digest !== manifest.digest) {
    throw new BranchLiftError(`Remote ${remote.name} returned an invalid live-sync receipt.`);
  }
  const transferredBytes = missing.reduce((total, path) => {
    const entry = entries.get(path);
    return total + (entry?.kind === "file" ? entry.size : 0);
  }, 0);
  const receipt: LiveSyncResult = {
    remote: remote.name,
    branch,
    digest: manifest.digest,
    files: manifest.entries.length,
    transferredFiles: missing.length,
    transferredBytes,
    deletedFiles: deletions.length,
    alreadyCurrent: false,
  };
  await recordEventBestEffort(repo, "remote.live.sync", `Mirrored working tree changes to ${remote.name}:${branch}.`, {
    branch,
    details: { remote: remote.name, digest: manifest.digest, transferredFiles: missing.length, transferredBytes, deletedFiles: deletions.length },
  });
  return receipt;
}

export async function watchRemoteWorkingTree(
  repo: RepoInfo,
  remoteName: string,
  branch: string,
  options: LiveWatchOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 2_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
    throw new BranchLiftError("Live-sync interval must be between 250 and 60000 milliseconds.");
  }
  let closed = false;
  let syncing = false;
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  let lastDigest: string | undefined;
  let lastFingerprint: string | undefined;
  const synchronize = async (): Promise<void> => {
    if (closed) return;
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    try {
      const fingerprint = await liveWorkingTreeFingerprint(repo);
      if (fingerprint === lastFingerprint) return;
      const result = await syncRemoteWorkingTree(repo, remoteName, branch);
      if (result.digest !== lastDigest || !result.alreadyCurrent) options.onSync?.(result);
      lastDigest = result.digest;
      lastFingerprint = fingerprint;
    } finally {
      syncing = false;
      if (pending && !closed) {
        pending = false;
        await synchronize();
      }
    }
  };
  const schedule = (): void => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void synchronize().catch((error: unknown) => {
      process.stderr.write(`Live sync failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }), 200);
    timer.unref();
  };
  await synchronize();
  let watcher: ReturnType<typeof watchFs> | undefined;
  try {
    watcher = watchFs(repo.root, { recursive: true }, (_event, filename) => {
      const path = filename?.toString().split(sep).join("/");
      if (path === undefined || path === ".git" || path.startsWith(".git/")) return;
      schedule();
    });
    watcher.once("error", (error) => {
      process.stderr.write(`Native file watch unavailable; periodic live-sync reconciliation remains active: ${error.message}\n`);
      watcher?.close();
      watcher = undefined;
    });
  } catch (error) {
    process.stderr.write(`Native file watch unavailable; periodic live-sync reconciliation remains active: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const reconciliation = setInterval(schedule, intervalMs);
  reconciliation.unref();
  await new Promise<void>((resolveDone) => {
    const finish = (): void => resolveDone();
    if (options.signal?.aborted === true) finish();
    else options.signal?.addEventListener("abort", finish, { once: true });
  });
  closed = true;
  watcher?.close();
  clearInterval(reconciliation);
  if (timer !== undefined) clearTimeout(timer);
}

export async function runRemoteReceiver(): Promise<number> {
  let id = "unknown";
  try {
    const input = new BinaryInput(process.stdin);
    const header = parseTransferHeader(JSON.parse(await input.readLine(maximumHeaderBytes)) as unknown);
    id = header.id;
    const result = header.kind === "code"
      ? await receiveCode(input, header)
      : header.kind === "snapshot"
        ? await receiveSnapshot(input, header)
        : header.kind === "live-plan"
          ? await receiveLivePlan(input, header)
          : await receiveLiveApply(input, header);
    writeTransferResponse({ protocol: 1, id, ok: true, result });
    return 0;
  } catch (error) {
    writeTransferResponse({
      protocol: 1,
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function receiveCode(input: BinaryInput, header: CodeTransferHeader): Promise<unknown> {
  const temporary = await mkdtemp(join(tmpdir(), "branchlift-code-receive-"));
  const bundle = join(temporary, "code.bundle");
  try {
    const digest = await input.readFile(header.bundleBytes, bundle);
    if (digest !== header.bundleDigest) throw new BranchLiftError("Transferred Git bundle failed SHA-256 verification.");
    await input.assertEnd();
    const target = resolve(header.repoPath);
    if (target === resolve(sep)) throw new BranchLiftError("Refusing to synchronize a repository at the filesystem root.");
    const existed = await pathExists(target);
    if (!existed) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await mkdir(target, { mode: 0o700 });
    }
    try {
      if (!existed) await runCommand("git", ["init", "-q"], { cwd: target });
      const repo = await discoverRepo(target);
      if (await realpath(repo.root) !== await realpath(target)) {
        throw new BranchLiftError("Remote repository path must be the Git worktree root.");
      }
      return await withLock(repo, "remote-workspace", "remote code sync", async () => {
        if (existed) {
          const statusResult = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: target });
          if (statusResult.stdout.trim() !== "") {
            throw new BranchLiftError("Remote repository has uncommitted or untracked files; refusing to overwrite it.");
          }
        }
        await runCommand("git", ["bundle", "verify", bundle], { cwd: target });
        await runCommand("git", ["fetch", "--no-tags", bundle, "HEAD"], { cwd: target });
        const fetched = (await runCommand("git", ["rev-parse", "FETCH_HEAD"], { cwd: target })).stdout.trim();
        if (fetched !== header.commit) throw new BranchLiftError("Git bundle HEAD does not match the declared commit.");
        if (existed) await assertNoIgnoredCheckoutConflicts(target, header.commit);
        await runCommand("git", ["checkout", "--detach", header.commit], { cwd: target });
        await runCommand("git", ["update-ref", "refs/branchlift/sync/latest", header.commit], { cwd: target });
        return { repository: await realpath(target), commit: header.commit, created: !existed };
      });
    } catch (error) {
      if (!existed) await rm(target, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function receiveSnapshot(input: BinaryInput, header: SnapshotTransferHeader): Promise<unknown> {
  process.chdir(header.repoPath);
  const repo = await discoverRepo();
  validateManifest(header.manifest, header.snapshot);
  validateSnapshotMetadata(header.metadata, header.snapshot, header.manifest);
  const files = uniqueFileEntries(header.manifest);
  const sent = new Set(header.sentDigests);
  if (sent.size !== header.sentDigests.length) throw new BranchLiftError("Snapshot transfer contains duplicate blob digests.");
  for (const digest of sent) {
    if (!files.has(digest)) throw new BranchLiftError(`Snapshot transfer declared an unknown blob: ${digest}`);
  }
  const symlinks = validateSymlinkMap(header.symlinks, header.manifest);
  return await withLock(repo, snapshotLockScope(header.snapshot), "remote snapshot receive", async () => {
    const finalPath = snapshotRoot(repo, header.snapshot);
    if (await pathExists(finalPath)) {
      await input.assertEnd();
      const existing = await readSnapshotMetadata(repo, header.snapshot);
      if (existing.contentDigest === header.manifest.digest) {
        await verifySnapshotContent(repo, header.snapshot, header.manifest.digest, header.metadata.volumeNames);
        return { snapshot: header.snapshot, digest: header.manifest.digest, alreadyPresent: true };
      }
      throw new BranchLiftError(`Remote snapshot ${header.snapshot} already exists with different content.`);
    }
    const blobRoot = join(repoDataRoot(repo), "blobs", "sha256");
    await mkdir(blobRoot, { recursive: true, mode: 0o700 });
    for (const expectedDigest of header.sentDigests) {
      const frame = parseBlobFrame(JSON.parse(await input.readLine(4096)) as unknown);
      if (frame.digest !== expectedDigest) throw new BranchLiftError("Snapshot blob frames are out of order.");
      const manifestEntry = files.get(frame.digest);
      if (manifestEntry === undefined || manifestEntry.size !== frame.size) {
        throw new BranchLiftError(`Snapshot blob size does not match its manifest: ${frame.digest}`);
      }
      const destination = blobPath(blobRoot, frame.digest);
      const temporary = `${destination}.${randomUUID()}.incoming`;
      const actualDigest = await input.readFile(frame.size, temporary);
      if (actualDigest !== frame.digest) {
        await rm(temporary, { force: true });
        throw new BranchLiftError(`Snapshot blob failed SHA-256 verification: ${frame.digest}`);
      }
      if (await pathExists(destination)) await rm(temporary, { force: true });
      else {
        await chmod(temporary, 0o400);
        await rename(temporary, destination);
      }
    }
    await input.assertEnd();
    for (const [digest, entry] of files) {
      const path = blobPath(blobRoot, digest);
      let valid = false;
      try {
        const info = await lstat(path);
        valid = info.isFile() && !info.isSymbolicLink() && info.size === entry.size && await hashFile(path) === digest;
      } catch {
        valid = false;
      }
      if (!valid) {
        await rm(path, { force: true });
        throw new BranchLiftError(`Remote blob is missing or corrupt: ${digest}. Retry the push.`);
      }
    }
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    const staging = `${finalPath}.${randomUUID()}.incoming`;
    await mkdir(join(staging, "volumes"), { recursive: true, mode: 0o700 });
    try {
      await materializeSnapshot(staging, blobRoot, header.manifest, header.metadata.volumeNames, symlinks);
      const verified = await createSnapshotManifest(header.snapshot, join(staging, "volumes"), header.metadata.volumeNames);
      if (verified.digest !== header.manifest.digest) {
        throw new BranchLiftError("Materialized snapshot failed manifest verification.");
      }
      await makeTreeReadOnly(join(staging, "volumes"));
      await writeSnapshotManifest(staging, header.manifest);
      const metadata: SnapshotMetadata = {
        ...header.metadata,
        repoKey: repo.key,
        sourceRoot: repo.root,
        composeProject: projectName(repo, `remote-${header.snapshot}`),
        status: "ready",
        contentDigest: header.manifest.digest,
        manifestFile: "manifest.json",
        fileCount: header.manifest.entries.length,
      };
      delete metadata.error;
      await writeJsonAtomic(join(staging, "metadata.json"), metadata);
      await rename(staging, finalPath);
      return {
        snapshot: header.snapshot,
        digest: header.manifest.digest,
        logicalBytes: header.manifest.logicalBytes,
        receivedBlobs: header.sentDigests.length,
        reusedBlobs: files.size - header.sentDigests.length,
        alreadyPresent: false,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  });
}

async function receiveLivePlan(input: BinaryInput, header: LivePlanTransferHeader): Promise<unknown> {
  await input.assertEnd();
  process.chdir(header.repoPath);
  const repo = await discoverRepo();
  validateLiveManifest(header.manifest);
  return await withLock(repo, instanceLockScope(header.manifest.branch), "remote live-sync plan", async () => {
    const plan = await calculateLivePlan(repo, header.manifest);
    const stored: StoredLivePlan = {
      version: 1,
      id: header.id,
      createdAt: new Date().toISOString(),
      manifest: header.manifest,
      missing: plan.missing,
      deletions: plan.deletions,
      ...(plan.previousDigest === undefined ? {} : { previousDigest: plan.previousDigest }),
    };
    if (plan.missing.length > 0 || plan.deletions.length > 0) await writeJsonAtomic(livePlanPath(repo, header.id), stored);
    return { planId: header.id, missing: plan.missing, deletions: plan.deletions, alreadyCurrent: plan.missing.length === 0 && plan.deletions.length === 0 };
  });
}

async function receiveLiveApply(input: BinaryInput, header: LiveApplyTransferHeader): Promise<unknown> {
  process.chdir(header.repoPath);
  const repo = await discoverRepo();
  validateLiveManifest(header.manifest);
  if (!/^[a-f0-9-]{1,100}$/i.test(header.planId)) throw new BranchLiftError("Invalid live-sync plan identifier.");
  const planPath = livePlanPath(repo, header.planId);
  if (!(await pathExists(planPath))) throw new BranchLiftError("Live-sync plan is missing or expired; retry synchronization.");
  const stored = await readJson<unknown>(planPath);
  if (!isStoredLivePlan(stored) || stored.manifest.digest !== header.manifest.digest
    || stored.manifest.branch !== header.manifest.branch) {
    throw new BranchLiftError("Live-sync plan does not match the requested manifest.");
  }
  if (Date.now() - Date.parse(stored.createdAt) > 120_000) {
    await rm(planPath, { force: true });
    throw new BranchLiftError("Live-sync plan expired; retry synchronization.");
  }
  const expectedSent = [...stored.missing].sort();
  const actualSent = [...header.sentPaths].sort();
  if (JSON.stringify(expectedSent) !== JSON.stringify(actualSent)) {
    throw new BranchLiftError("Live-sync payload paths do not match the remote plan.");
  }
  const entries = new Map(header.manifest.entries.map((entry) => [entry.path, entry]));
  const staging = await mkdtemp(join(tmpdir(), "branchlift-live-sync-"));
  try {
    for (const path of header.sentPaths) {
      const entry = entries.get(path);
      if (entry === undefined) throw new BranchLiftError(`Live-sync payload contains an unknown path: ${path}`);
      if (entry.kind === "symlink") continue;
      const frame = parseLiveFrame(JSON.parse(await input.readLine(4096)) as unknown);
      if (frame.path !== path || frame.size !== entry.size || frame.digest !== entry.digest) {
        throw new BranchLiftError(`Live-sync frame does not match its manifest: ${path}`);
      }
      const destination = join(staging, createHash("sha256").update(path).digest("hex"));
      const digest = await input.readFile(frame.size, destination);
      if (digest !== entry.digest) throw new BranchLiftError(`Live-sync file failed SHA-256 verification: ${path}`);
    }
    await input.assertEnd();
    return await withLock(repo, instanceLockScope(header.manifest.branch), "remote live-sync apply", async () => {
      const fresh = await calculateLivePlan(repo, header.manifest);
      if (fresh.previousDigest !== stored.previousDigest
        || JSON.stringify([...fresh.missing].sort()) !== JSON.stringify(expectedSent)
        || JSON.stringify([...fresh.deletions].sort()) !== JSON.stringify([...stored.deletions].sort())) {
        throw new BranchLiftError("Remote worktree changed after the live-sync plan; refusing to overwrite it.");
      }
      const metadata = await readInstanceMetadata(repo, safeInstanceSlug(header.manifest.branch));
      await applyLiveChanges(metadata.worktreePath, header.manifest, stored, staging);
      const state: StoredLiveState = { version: 1, appliedAt: new Date().toISOString(), manifest: header.manifest };
      await writeJsonAtomic(liveStatePath(repo, header.manifest.branch), state);
      await rm(planPath, { force: true });
      return {
        branch: header.manifest.branch,
        digest: header.manifest.digest,
        transferredFiles: stored.missing.length,
        deletedFiles: stored.deletions.length,
      };
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function calculateLivePlan(
  repo: RepoInfo,
  manifest: LiveSyncManifest,
): Promise<{ missing: string[]; deletions: string[]; previousDigest?: string }> {
  const metadata = await readInstanceMetadata(repo, safeInstanceSlug(manifest.branch));
  if (metadata.branch !== manifest.branch) throw new BranchLiftError("Live-sync branch metadata is inconsistent.");
  if (!(await pathExists(metadata.worktreePath))) throw new BranchLiftError(`Remote worktree is missing: ${metadata.worktreePath}`);
  const currentCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: metadata.worktreePath })).stdout.trim();
  if (currentCommit !== manifest.baseCommit) {
    throw new BranchLiftError("Remote branch commit differs from the live-sync base commit; run remote launch again.");
  }
  const statePath = liveStatePath(repo, manifest.branch);
  let previous: StoredLiveState | undefined;
  if (await pathExists(statePath)) {
    const value = await readJson<unknown>(statePath);
    if (!isStoredLiveState(value)) throw new BranchLiftError("Remote live-sync state is invalid; refusing to overwrite the worktree.");
    previous = value;
    for (const entry of previous.manifest.entries) {
      if (!(await liveEntryMatches(metadata.worktreePath, entry))) {
        throw new BranchLiftError(`Remote worktree changed outside live sync: ${entry.path}`);
      }
    }
  } else {
    const status = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: metadata.worktreePath });
    if (status.stdout.trim() !== "") {
      throw new BranchLiftError("Remote worktree has changes; refusing to start one-way live sync.");
    }
  }
  const ignored = (await runCommand("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: metadata.worktreePath }))
    .stdout.split("\0").filter(Boolean);
  const previousPaths = new Set(previous?.manifest.entries.map((entry) => entry.path) ?? []);
  for (const entry of manifest.entries) {
    if (previousPaths.has(entry.path)) continue;
    const conflict = ignored.find((path) => pathsCollide(path, entry.path));
    if (conflict !== undefined) throw new BranchLiftError(`Live sync would overwrite an ignored remote path: ${conflict}`);
  }
  const incoming = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const tracked = (await runCommand("git", ["ls-files", "-z"], { cwd: metadata.worktreePath })).stdout.split("\0").filter(Boolean);
  const managed = new Set([...tracked, ...previousPaths]);
  const deletions = [...managed].filter((path) => !incoming.has(path)).sort();
  const missing: string[] = [];
  for (const entry of manifest.entries) if (!(await liveEntryMatches(metadata.worktreePath, entry))) missing.push(entry.path);
  return {
    missing: missing.sort(),
    deletions,
    ...(previous === undefined ? {} : { previousDigest: previous.manifest.digest }),
  };
}

async function applyLiveChanges(
  worktree: string,
  manifest: LiveSyncManifest,
  plan: StoredLivePlan,
  staging: string,
): Promise<void> {
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const affected = [...new Set([...plan.deletions, ...plan.missing])].sort();
  const backups: Array<{ path: string; kind: "file" | "symlink"; mode: number; backup?: string; target?: string }> = [];
  for (const path of affected) {
    const destination = liveDestination(worktree, path);
    try {
      const info = await lstat(destination);
      if (info.isDirectory()) throw new BranchLiftError(`Live sync refuses a file/directory shape change: ${path}`);
      if (info.isSymbolicLink()) backups.push({ path, kind: "symlink", mode: info.mode & 0o7777, target: await readlink(destination) });
      else if (info.isFile()) {
        const backup = join(staging, `backup-${backups.length}`);
        await copyFile(destination, backup);
        backups.push({ path, kind: "file", mode: info.mode & 0o7777, backup });
      } else throw new BranchLiftError(`Live sync refuses a non-file target: ${path}`);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  try {
    for (const path of [...plan.deletions].sort((left, right) => right.length - left.length)) {
      await rm(liveDestination(worktree, path), { force: true });
    }
    for (const path of plan.missing) {
      const entry = entries.get(path);
      if (entry === undefined) throw new BranchLiftError(`Live-sync manifest path disappeared: ${path}`);
      const destination = liveDestination(worktree, path);
      await ensureLiveParent(worktree, dirname(destination));
      await rm(destination, { force: true });
      if (entry.kind === "symlink") {
        if (entry.target === undefined) throw new BranchLiftError(`Live-sync symlink target is missing: ${path}`);
        assertSafeLiveSymlink(destination, worktree, entry.target);
        await symlink(entry.target, destination);
      } else {
        const source = join(staging, createHash("sha256").update(path).digest("hex"));
        const temporary = `${destination}.${randomUUID()}.branchlift`;
        await copyFile(source, temporary);
        await chmod(temporary, entry.mode & 0o7777);
        await rename(temporary, destination);
      }
    }
  } catch (error) {
    for (const path of affected.reverse()) await rm(liveDestination(worktree, path), { force: true });
    for (const backup of backups) {
      const destination = liveDestination(worktree, backup.path);
      await ensureLiveParent(worktree, dirname(destination));
      if (backup.kind === "symlink") await symlink(backup.target!, destination);
      else {
        await copyFile(backup.backup!, destination);
        await chmod(destination, backup.mode);
      }
    }
    throw error;
  }
}

async function assertNoIgnoredCheckoutConflicts(target: string, commit: string): Promise<void> {
  const ignoredResult = await runCommand("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: target });
  const trackedResult = await runCommand("git", ["ls-tree", "-r", "--name-only", "-z", commit], { cwd: target });
  const ignored = ignoredResult.stdout.split("\0").filter((path) => path !== "");
  const tracked = trackedResult.stdout.split("\0").filter((path) => path !== "");
  const conflict = ignored.find((ignoredPath) => tracked.some((trackedPath) => pathsCollide(ignoredPath, trackedPath)));
  if (conflict !== undefined) {
    throw new BranchLiftError(
      `Remote repository has an ignored path that conflicts with the incoming commit: ${conflict}`,
      "Move or remove the host-only path explicitly, then retry. BranchLift will not overwrite it.",
    );
  }
}

function pathsCollide(left: string, right: string): boolean {
  const normalizedLeft = left.endsWith("/") ? left.slice(0, -1) : left;
  const normalizedRight = right.endsWith("/") ? right.slice(0, -1) : right;
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

async function createLiveSyncManifest(repo: RepoInfo, branch: string): Promise<LiveSyncManifest> {
  if (branch.trim() === "" || branch.length > 300 || /[\0\r\n]/.test(branch)) throw new BranchLiftError("Invalid live-sync branch.");
  const baseCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
  if (!commitPattern.test(baseCommit)) throw new BranchLiftError("Git returned an unsupported live-sync base commit.");
  const paths = await liveSyncPaths(repo);
  const entries: LiveSyncEntry[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (!safePortablePath(path)) throw new BranchLiftError(`Git returned an unsafe live-sync path: ${path}`);
    const source = resolveLiveSource(repo, path);
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (info.isDirectory()) continue;
    if (info.isSymbolicLink()) {
      const target = await readlink(source);
      assertSafeLiveSymlink(source, repo.root, target);
      entries.push({
        path,
        kind: "symlink",
        size: Buffer.byteLength(target),
        mode: info.mode & 0o7777,
        digest: `sha256:${createHash("sha256").update(target).digest("hex")}`,
        target,
      });
      continue;
    }
    if (!info.isFile()) throw new BranchLiftError(`Live sync supports only regular files and safe symlinks: ${path}`);
    if (info.size > 256 * 1024 * 1024) throw new BranchLiftError(`Live-sync file exceeds 256 MiB: ${path}`);
    totalBytes += info.size;
    if (totalBytes > 2 * 1024 * 1024 * 1024) throw new BranchLiftError("Live-sync working set exceeds 2 GiB.");
    entries.push({ path, kind: "file", size: info.size, mode: info.mode & 0o7777, digest: await hashFile(source) });
  }
  const digest = liveManifestDigest(entries);
  return { version: 1, branch, baseCommit, generatedAt: new Date().toISOString(), digest, entries };
}

async function liveWorkingTreeFingerprint(repo: RepoInfo): Promise<string> {
  const hash = createHash("sha256");
  for (const path of await liveSyncPaths(repo)) {
    const source = resolveLiveSource(repo, path);
    try {
      const info = await lstat(source);
      hash.update(`${path}\0${info.mode & 0o7777}\0${info.size}\0${info.mtimeMs}\0${info.ctimeMs}\0`);
      if (info.isSymbolicLink()) hash.update(await readlink(source));
      else if (!info.isFile() && !info.isDirectory()) hash.update("unsupported");
      hash.update("\n");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      hash.update(`${path}\0missing\n`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function liveSyncPaths(repo: RepoInfo): Promise<string[]> {
  const output = (await runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repo.root })).stdout;
  const paths = [...new Set(output.split("\0").filter(Boolean))].sort();
  if (paths.length > 100_000) throw new BranchLiftError("Live sync exceeds the 100000-file safety limit.");
  return paths;
}

function validateLiveManifest(manifest: LiveSyncManifest): void {
  if (!isRecord(manifest) || manifest.version !== 1 || typeof manifest.branch !== "string"
    || manifest.branch.trim() === "" || manifest.branch.length > 300 || /[\0\r\n]/.test(manifest.branch)
    || typeof manifest.baseCommit !== "string" || !commitPattern.test(manifest.baseCommit)
    || typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt))
    || typeof manifest.digest !== "string" || !digestPattern.test(manifest.digest)
    || !Array.isArray(manifest.entries) || manifest.entries.length > 100_000) {
    throw new BranchLiftError("Live-sync manifest is invalid.");
  }
  assertOnlyKeys(manifest as unknown as Record<string, unknown>, ["version", "branch", "baseCommit", "generatedAt", "digest", "entries"]);
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !safePortablePath(entry.path)
      || (entry.kind !== "file" && entry.kind !== "symlink")
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 256 * 1024 * 1024
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
      || typeof entry.digest !== "string" || !digestPattern.test(entry.digest)) {
      throw new BranchLiftError("Live-sync manifest contains an invalid entry.");
    }
    assertOnlyKeys(entry, ["path", "kind", "size", "mode", "digest", "target"]);
    if (paths.has(entry.path)) throw new BranchLiftError(`Duplicate live-sync path: ${entry.path}`);
    paths.add(entry.path);
    if (entry.kind === "symlink") {
      if (typeof entry.target !== "string" || Buffer.byteLength(entry.target) !== entry.size
        || `sha256:${createHash("sha256").update(entry.target).digest("hex")}` !== entry.digest) {
        throw new BranchLiftError(`Invalid live-sync symlink: ${entry.path}`);
      }
    } else if (entry.target !== undefined) throw new BranchLiftError(`Live-sync regular file has a symlink target: ${entry.path}`);
  }
  if (liveManifestDigest(manifest.entries) !== manifest.digest) throw new BranchLiftError("Live-sync manifest digest is invalid.");
}

function liveManifestDigest(entries: LiveSyncEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.path}\0${entry.kind}\0${entry.size}\0${entry.mode}\0${entry.digest}\0${entry.target ?? ""}\n`);
  return `sha256:${hash.digest("hex")}`;
}

async function liveEntryMatches(root: string, entry: LiveSyncEntry): Promise<boolean> {
  const path = liveDestination(root, entry.path);
  try {
    const info = await lstat(path);
    if ((info.mode & 0o7777) !== entry.mode) return false;
    if (entry.kind === "symlink") {
      if (!info.isSymbolicLink()) return false;
      const target = await readlink(path);
      return target === entry.target && `sha256:${createHash("sha256").update(target).digest("hex")}` === entry.digest;
    }
    return info.isFile() && !info.isSymbolicLink() && info.size === entry.size && await hashFile(path) === entry.digest;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function resolveLiveSource(repo: RepoInfo, path: string): string {
  const source = resolve(repo.root, path);
  if (!isWithin(repo.root, source)) throw new BranchLiftError(`Live-sync source escapes the repository: ${path}`);
  return source;
}

function liveDestination(root: string, path: string): string {
  if (!safePortablePath(path)) throw new BranchLiftError(`Unsafe live-sync path: ${path}`);
  const destination = resolve(root, ...path.split("/"));
  if (!isWithin(root, destination) || destination === resolve(root)) throw new BranchLiftError(`Live-sync path escapes its worktree: ${path}`);
  return destination;
}

async function ensureLiveParent(root: string, parent: string): Promise<void> {
  const relativeParent = relative(resolve(root), resolve(parent));
  if (relativeParent === "") return;
  if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
    throw new BranchLiftError("Live-sync parent escapes its worktree.");
  }
  let current = resolve(root);
  for (const segment of relativeParent.split(sep)) {
    current = join(current, segment);
    if (await pathExists(current)) {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BranchLiftError(`Live-sync parent is not a safe directory: ${current}`);
    } else await mkdir(current, { mode: 0o700 });
  }
}

function assertSafeLiveSymlink(linkPath: string, root: string, target: string): void {
  if (target === "" || isAbsolute(target) || /[\0\r\n]/.test(target)) throw new BranchLiftError(`Live-sync symlink target is unsafe: ${linkPath}`);
  if (!isWithin(root, resolve(dirname(linkPath), target))) throw new BranchLiftError(`Live-sync symlink escapes its worktree: ${linkPath}`);
}

function liveStatePath(repo: RepoInfo, branch: string): string {
  return join(repoDataRoot(repo), "live-sync", `${safeSlug(branch)}.json`);
}

function livePlanPath(repo: RepoInfo, id: string): string {
  return join(repoDataRoot(repo), "live-sync", "plans", `${id}.json`);
}

function safeInstanceSlug(branch: string): string {
  return safeSlug(branch);
}

function parseLiveFrame(value: unknown): { path: string; size: number; digest: string } {
  if (!isRecord(value) || typeof value.path !== "string" || !safePortablePath(value.path)
    || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > 256 * 1024 * 1024
    || typeof value.digest !== "string" || !digestPattern.test(value.digest)) {
    throw new BranchLiftError("Invalid live-sync file frame.");
  }
  assertOnlyKeys(value, ["path", "size", "digest"]);
  return { path: value.path, size: Number(value.size), digest: value.digest };
}

function isStoredLivePlan(value: unknown): value is StoredLivePlan {
  return isRecord(value) && value.version === 1 && typeof value.id === "string" && typeof value.createdAt === "string"
    && isRecord(value.manifest) && Array.isArray(value.missing) && value.missing.every((path) => typeof path === "string")
    && Array.isArray(value.deletions) && value.deletions.every((path) => typeof path === "string")
    && (value.previousDigest === undefined || typeof value.previousDigest === "string");
}

function isStoredLiveState(value: unknown): value is StoredLiveState {
  return isRecord(value) && value.version === 1 && typeof value.appliedAt === "string" && isRecord(value.manifest);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function materializeSnapshot(
  staging: string,
  blobRoot: string,
  manifest: SnapshotManifest,
  volumeNames: string[],
  symlinks: Map<string, string>,
): Promise<void> {
  const volumeRoot = join(staging, "volumes");
  for (const volume of new Set(volumeNames)) {
    await mkdir(join(volumeRoot, volumeDirectoryName(volume)), { recursive: true, mode: 0o700 });
  }
  const directories = manifest.entries.filter((entry) => entry.kind === "directory").sort((a, b) => a.path.length - b.path.length);
  for (const entry of directories) await mkdir(snapshotDestination(volumeRoot, entry), { recursive: true, mode: 0o700 });
  for (const entry of manifest.entries.filter((item) => item.kind !== "directory")) {
    const destination = snapshotDestination(volumeRoot, entry);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (entry.kind === "file") {
      await copyBlob(blobPath(blobRoot, entry.digest), destination);
      await chmod(destination, entry.mode & 0o7777);
    } else {
      const target = symlinks.get(entryKey(entry));
      if (target === undefined) throw new BranchLiftError(`Missing symlink target for ${entry.volume}:${entry.path}.`);
      assertSafeSymlinkTarget(destination, join(volumeRoot, volumeDirectoryName(entry.volume)), target);
      await symlink(target, destination);
    }
  }
  for (const entry of directories.sort((a, b) => b.path.length - a.path.length)) {
    await chmod(snapshotDestination(volumeRoot, entry), entry.mode & 0o7777);
  }
}

async function copyBlob(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
  } catch {
    await copyFile(source, destination);
  }
}

async function planRemoteSnapshot(
  repo: RepoInfo,
  remote: string,
  snapshot: string,
  manifestDigest: string,
  digests: string[],
): Promise<{ missing: Set<string>; alreadyPresent: boolean }> {
  const missing = new Set<string>();
  const batches: string[][] = [];
  for (let index = 0; index < digests.length; index += 400) batches.push(digests.slice(index, index + 400));
  if (batches.length === 0) batches.push([]);
  let alreadyPresent = false;
  for (const batch of batches) {
    const result = await callRemote(repo, remote, {
      action: "snapshot-plan",
      snapshot,
      manifestDigest,
      digests: batch,
    });
    if (!isRecord(result) || !Array.isArray(result.missing) || typeof result.alreadyPresent !== "boolean") {
      throw new BranchLiftError(`Remote ${remote} returned an invalid snapshot plan.`);
    }
    if (result.alreadyPresent) alreadyPresent = true;
    for (const digest of result.missing) {
      if (typeof digest !== "string" || !batch.includes(digest)) throw new BranchLiftError(`Remote ${remote} returned an invalid blob digest.`);
      missing.add(digest);
    }
  }
  return { missing, alreadyPresent };
}

async function sendTransfer(
  remote: RemoteDefinition,
  id: string,
  writer: (stream: Writable) => Promise<void>,
): Promise<unknown> {
  const args = remoteSshArguments(remote);
  args.push("--", remoteDestination(remote), remote.binary, "receive");
  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
  if (child.stdin === null || child.stdout === null || child.stderr === null) throw new BranchLiftError("Could not open SSH transfer streams.");
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
    outputBytes += chunk.length;
    if (outputBytes > maximumTransferOutputBytes) {
      child.kill("SIGKILL");
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  const closed = new Promise<number>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code) => resolveClose(code ?? 1));
  });
  try {
    await writer(child.stdin);
    child.stdin.end();
  } catch (error) {
    child.stdin.destroy();
    child.kill("SIGKILL");
    await closed.catch(() => undefined);
    throw error;
  }
  const exitCode = await closed;
  if (outputBytes > maximumTransferOutputBytes) throw new BranchLiftError("Remote transfer output exceeded the 1 MiB safety limit.");
  const response = parseTransferResponse(stdout, id);
  if (response === undefined) {
    throw new BranchLiftError(
      `Remote ${remote.name} did not return a valid transfer receipt.`,
      stderr.trim() || stdout.trim() || `ssh exited ${exitCode}`,
    );
  }
  if (!response.ok) throw new BranchLiftError(`Remote ${remote.name} rejected the transfer.`, response.error);
  if (exitCode !== 0) throw new BranchLiftError(`Remote transfer exited with status ${exitCode}.`, stderr.trim());
  return response.result;
}

class BinaryInput {
  private readonly iterator: AsyncIterator<Buffer | string>;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  }

  async readLine(limit: number): Promise<string> {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline > limit) throw new BranchLiftError("Transfer header exceeds its safety limit.");
        const value = this.buffer.subarray(0, newline).toString("utf8");
        this.buffer = this.buffer.subarray(newline + 1);
        return value;
      }
      if (this.buffer.length > limit) throw new BranchLiftError("Transfer header exceeds its safety limit.");
      await this.fill();
      if (this.ended) throw new BranchLiftError("Transfer ended before a complete header was received.");
    }
  }

  async readFile(bytes: number, destination: string): Promise<string> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumBundleBytes) throw new BranchLiftError("Invalid transfer payload size.");
    const handle = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let remaining = bytes;
    try {
      while (remaining > 0) {
        if (this.buffer.length === 0) {
          await this.fill();
          if (this.ended) throw new BranchLiftError("Transfer ended before the declared payload size.");
        }
        const length = Math.min(remaining, this.buffer.length);
        const chunk = this.buffer.subarray(0, length);
        await handle.write(chunk);
        hash.update(chunk);
        this.buffer = this.buffer.subarray(length);
        remaining -= length;
      }
    } catch (error) {
      await handle.close();
      await rm(destination, { force: true });
      throw error;
    }
    await handle.close();
    return `sha256:${hash.digest("hex")}`;
  }

  async assertEnd(): Promise<void> {
    if (this.buffer.length > 0) throw new BranchLiftError("Transfer contains trailing bytes.");
    if (!this.ended) await this.fill();
    if (this.buffer.length > 0 || !this.ended) throw new BranchLiftError("Transfer contains trailing bytes.");
  }

  private async fill(): Promise<void> {
    if (this.ended) return;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return;
    }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }
}

async function writeLine(stream: Writable, value: unknown): Promise<void> {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
  if (encoded.length > maximumHeaderBytes) throw new BranchLiftError("Transfer header exceeds the 32 MiB safety limit.");
  await writeBuffer(stream, encoded);
}

async function writeFileToStream(stream: Writable, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) await writeBuffer(stream, chunk as Buffer);
}

async function writeBuffer(stream: Writable, buffer: Buffer): Promise<void> {
  if (stream.write(buffer)) return;
  await new Promise<void>((resolveDrain, rejectDrain) => {
    const cleanup = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolveDrain();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectDrain(error);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

function parseTransferHeader(value: unknown): TransferHeader {
  if (!isRecord(value) || value.protocol !== transferProtocol || typeof value.id !== "string"
    || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)) {
    throw new BranchLiftError("Invalid transfer header.");
  }
  if (value.kind !== "code" && value.kind !== "snapshot" && value.kind !== "live-plan" && value.kind !== "live-apply") {
    throw new BranchLiftError("Unsupported transfer kind.");
  }
  const repoPath = requiredRemotePath(value.repoPath);
  if (value.kind === "code") {
    if (typeof value.commit !== "string" || !commitPattern.test(value.commit)
      || !Number.isSafeInteger(value.bundleBytes) || Number(value.bundleBytes) <= 0 || Number(value.bundleBytes) > maximumBundleBytes
      || typeof value.bundleDigest !== "string" || !digestPattern.test(value.bundleDigest)) {
      throw new BranchLiftError("Invalid code-transfer header.");
    }
    assertOnlyKeys(value, ["protocol", "id", "kind", "repoPath", "commit", "bundleBytes", "bundleDigest"]);
    return {
      protocol: 1,
      id: value.id,
      kind: "code",
      repoPath,
      commit: value.commit,
      bundleBytes: Number(value.bundleBytes),
      bundleDigest: value.bundleDigest,
    };
  }
  if (value.kind === "live-plan") {
    if (!isRecord(value.manifest)) throw new BranchLiftError("Invalid live-sync plan header.");
    assertOnlyKeys(value, ["protocol", "id", "kind", "repoPath", "manifest"]);
    return { protocol: 1, id: value.id, kind: "live-plan", repoPath, manifest: value.manifest as unknown as LiveSyncManifest };
  }
  if (value.kind === "live-apply") {
    if (typeof value.planId !== "string" || !isRecord(value.manifest) || !Array.isArray(value.sentPaths)) {
      throw new BranchLiftError("Invalid live-sync apply header.");
    }
    assertOnlyKeys(value, ["protocol", "id", "kind", "repoPath", "planId", "manifest", "sentPaths"]);
    const sentPaths = value.sentPaths.map((path) => {
      if (typeof path !== "string" || !safePortablePath(path)) throw new BranchLiftError("Invalid live-sync payload path.");
      return path;
    });
    if (new Set(sentPaths).size !== sentPaths.length) throw new BranchLiftError("Live-sync payload contains duplicate paths.");
    return {
      protocol: 1,
      id: value.id,
      kind: "live-apply",
      repoPath,
      planId: value.planId,
      manifest: value.manifest as unknown as LiveSyncManifest,
      sentPaths,
    };
  }
  if (typeof value.snapshot !== "string" || !isRecord(value.manifest) || !isRecord(value.metadata)
    || !Array.isArray(value.sentDigests) || !Array.isArray(value.symlinks)) {
    throw new BranchLiftError("Invalid snapshot-transfer header.");
  }
  assertOnlyKeys(value, ["protocol", "id", "kind", "repoPath", "snapshot", "manifest", "metadata", "sentDigests", "symlinks"]);
  return {
    protocol: 1,
    id: value.id,
    kind: "snapshot",
    repoPath,
    snapshot: value.snapshot,
    manifest: value.manifest as unknown as SnapshotManifest,
    metadata: value.metadata as unknown as SnapshotMetadata,
    sentDigests: value.sentDigests.map((digest) => {
      if (typeof digest !== "string" || !digestPattern.test(digest)) throw new BranchLiftError("Invalid sent blob digest.");
      return digest;
    }),
    symlinks: value.symlinks.map((item) => {
      if (!isRecord(item) || typeof item.volume !== "string" || typeof item.path !== "string" || typeof item.target !== "string") {
        throw new BranchLiftError("Invalid snapshot symlink entry.");
      }
      assertOnlyKeys(item, ["volume", "path", "target"]);
      return { volume: item.volume, path: item.path, target: item.target };
    }),
  };
}

function validateManifest(manifest: SnapshotManifest, expectedName: string): void {
  if (manifest.version !== 1 || manifest.snapshot !== expectedName || typeof manifest.createdAt !== "string"
    || typeof manifest.digest !== "string" || !digestPattern.test(manifest.digest)
    || !Number.isSafeInteger(manifest.logicalBytes) || manifest.logicalBytes < 0 || !Array.isArray(manifest.entries)) {
    throw new BranchLiftError("Snapshot manifest is invalid.");
  }
  const keys = new Set<string>();
  let logicalBytes = 0;
  const digest = createHash("sha256");
  for (const entry of manifest.entries) {
    validateManifestEntry(entry);
    const key = entryKey(entry);
    if (keys.has(key)) throw new BranchLiftError(`Duplicate snapshot manifest path: ${entry.volume}:${entry.path}`);
    keys.add(key);
    if (entry.kind === "file") logicalBytes += entry.size;
    digest.update(`${entry.volume}\0${entry.path}\0${entry.kind}\0${entry.size}\0${entry.mode}\0${entry.digest}\n`);
  }
  if (logicalBytes !== manifest.logicalBytes || `sha256:${digest.digest("hex")}` !== manifest.digest) {
    throw new BranchLiftError("Snapshot manifest digest or logical size is invalid.");
  }
}

function validateManifestEntry(entry: SnapshotManifestEntry): void {
  if (!isRecord(entry) || typeof entry.volume !== "string" || entry.volume.trim() === "" || /[\0\r\n]/.test(entry.volume)
    || typeof entry.path !== "string" || !safePortablePath(entry.path)
    || (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink")
    || !Number.isSafeInteger(entry.size) || entry.size < 0
    || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
    || typeof entry.digest !== "string" || !digestPattern.test(entry.digest)) {
    throw new BranchLiftError("Snapshot manifest contains an invalid entry.");
  }
  assertOnlyKeys(entry, ["volume", "path", "kind", "size", "mode", "digest"]);
  if (entry.kind === "directory" && entry.size !== 0) throw new BranchLiftError("Snapshot directory entries must have zero size.");
  if (entry.kind === "directory" && (entry.mode & 0o500) !== 0o500) {
    throw new BranchLiftError("Transferred snapshot directories must be owner-readable and searchable.");
  }
  if (entry.kind === "file" && (entry.mode & 0o400) !== 0o400) {
    throw new BranchLiftError("Transferred snapshot files must be owner-readable.");
  }
}

function validateSnapshotMetadata(metadata: SnapshotMetadata, name: string, manifest: SnapshotManifest): void {
  if (metadata.version !== 1 || metadata.name !== name || name.length > 300 || /[\0\r\n]/.test(name) || metadata.status !== "ready"
    || !Array.isArray(metadata.volumeNames) || new Set(metadata.volumeNames).size !== metadata.volumeNames.length
    || metadata.volumeNames.some((volume) => typeof volume !== "string" || volume.trim() === "" || /[\0\r\n]/.test(volume))
    || metadata.contentDigest !== manifest.digest) {
    throw new BranchLiftError("Snapshot metadata is inconsistent with its manifest.");
  }
  assertOnlyKeys(metadata as unknown as Record<string, unknown>, [
    "version", "name", "repoKey", "sourceRoot", "composeFile", "composeFiles", "composeProject", "createdAt", "completedAt",
    "status", "volumeNames", "sizeBytes", "copyStrategy", "importedFromProject", "postgresDataDirectories",
    "mysqlLowerCaseTableNames", "parentSnapshot", "sourceInstance", "contentDigest", "manifestFile", "fileCount", "error",
  ]);
  const volumes = new Set(manifest.entries.map((entry) => entry.volume));
  for (const volume of volumes) {
    if (!metadata.volumeNames.includes(volume)) throw new BranchLiftError(`Snapshot metadata omits volume ${volume}.`);
  }
}

function validateSymlinkMap(
  values: Array<{ volume: string; path: string; target: string }>,
  manifest: SnapshotManifest,
): Map<string, string> {
  const expected = new Map(manifest.entries.filter((entry) => entry.kind === "symlink").map((entry) => [entryKey(entry), entry]));
  const result = new Map<string, string>();
  for (const value of values) {
    const key = `${value.volume}\0${value.path}`;
    const entry = expected.get(key);
    if (entry === undefined || result.has(key) || Buffer.byteLength(value.target) !== entry.size
      || `sha256:${createHash("sha256").update(value.target).digest("hex")}` !== entry.digest) {
      throw new BranchLiftError(`Invalid snapshot symlink data: ${value.volume}:${value.path}`);
    }
    result.set(key, value.target);
  }
  if (result.size !== expected.size) throw new BranchLiftError("Snapshot transfer is missing symlink targets.");
  return result;
}

function parseBlobFrame(value: unknown): { digest: string; size: number } {
  if (!isRecord(value) || typeof value.digest !== "string" || !digestPattern.test(value.digest)
    || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > maximumBundleBytes) {
    throw new BranchLiftError("Invalid snapshot blob frame.");
  }
  assertOnlyKeys(value, ["digest", "size"]);
  return { digest: value.digest, size: Number(value.size) };
}

async function snapshotSymlinks(
  repo: RepoInfo,
  name: string,
  manifest: SnapshotManifest,
): Promise<Array<{ volume: string; path: string; target: string }>> {
  const result: Array<{ volume: string; path: string; target: string }> = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== "symlink") continue;
    const target = await readlink(snapshotEntryPath(repo, name, entry));
    assertSafeSymlinkTarget(snapshotEntryPath(repo, name, entry), join(snapshotRoot(repo, name), "volumes", volumeDirectoryName(entry.volume)), target);
    result.push({ volume: entry.volume, path: entry.path, target });
  }
  return result;
}

function uniqueFileEntries(manifest: SnapshotManifest): Map<string, SnapshotManifestEntry> {
  const result = new Map<string, SnapshotManifestEntry>();
  for (const entry of manifest.entries) if (entry.kind === "file" && !result.has(entry.digest)) result.set(entry.digest, entry);
  return result;
}

function snapshotEntryPath(repo: RepoInfo, name: string, entry: SnapshotManifestEntry): string {
  return snapshotDestination(join(snapshotRoot(repo, name), "volumes"), entry);
}

function snapshotDestination(volumeRoot: string, entry: Pick<SnapshotManifestEntry, "volume" | "path">): string {
  if (!safePortablePath(entry.path)) throw new BranchLiftError("Unsafe snapshot manifest path.");
  const root = join(volumeRoot, volumeDirectoryName(entry.volume));
  const destination = resolve(root, ...entry.path.split("/"));
  if (!isWithin(root, destination)) throw new BranchLiftError("Snapshot path escapes its volume root.");
  return destination;
}

function assertSafeSymlinkTarget(linkPath: string, volumeRoot: string, target: string): void {
  if (target === "" || isAbsolute(target) || /[\0\r\n]/.test(target)) {
    throw new BranchLiftError(`Snapshot symlink must have a safe relative target: ${linkPath}`);
  }
  const resolvedTarget = resolve(dirname(linkPath), target);
  if (!isWithin(volumeRoot, resolvedTarget)) throw new BranchLiftError(`Snapshot symlink escapes its volume root: ${linkPath}`);
}

function safePortablePath(value: string): boolean {
  return value !== "" && !value.startsWith("/") && !value.includes("\\") && !/[\0\r\n]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function blobPath(root: string, digest: string): string {
  const match = digestPattern.exec(digest);
  if (match?.[1] === undefined) throw new BranchLiftError("Invalid SHA-256 blob digest.");
  return join(root, match[1]);
}

function entryKey(entry: Pick<SnapshotManifestEntry, "volume" | "path">): string {
  return `${entry.volume}\0${entry.path}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

function requiredRemotePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new BranchLiftError("Invalid remote repository path.");
  }
  return value;
}

function parseTransferResponse(stdout: string, expectedId: string): TransferResponse | undefined {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.startsWith(transferResponsePrefix)) continue;
    try {
      const value = JSON.parse(Buffer.from(line.slice(transferResponsePrefix.length), "base64url").toString("utf8")) as unknown;
      if (!isRecord(value) || value.protocol !== 1 || value.id !== expectedId || typeof value.ok !== "boolean") return undefined;
      return value as unknown as TransferResponse;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function writeTransferResponse(response: TransferResponse): void {
  process.stdout.write(`${transferResponsePrefix}${Buffer.from(JSON.stringify(response)).toString("base64url")}\n`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !keys.has(key));
  if (unexpected !== undefined) throw new BranchLiftError(`Unexpected transfer field: ${unexpected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
