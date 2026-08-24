import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { BranchLiftError } from "./errors.js";
import { pathExists, repoDataRoot, safeSlug } from "./paths.js";
import type { RepoInfo } from "./types.js";

const incompleteLockGraceMs = 5_000;

export interface LockMetadata {
  version: 1;
  token: string;
  scope: string;
  operation: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export interface LockInspection {
  path: string;
  metadata?: LockMetadata;
  status: "active" | "stale";
  reason: string;
}

export async function withLock<T>(
  repo: RepoInfo,
  scope: string,
  operation: string,
  task: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(repo, scope, operation);
  try {
    return await task();
  } finally {
    await releaseLock(lock.path, lock.metadata.token);
  }
}

export async function acquireLock(
  repo: RepoInfo,
  scope: string,
  operation: string,
): Promise<{ path: string; metadata: LockMetadata }> {
  const root = lockRoot(repo);
  await mkdir(root, { recursive: true });
  const path = lockPath(repo, scope);
  const metadata: LockMetadata = {
    version: 1,
    token: randomUUID(),
    scope,
    operation,
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };

  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    const inspection = await inspectLock(path);
    const owner = inspection.metadata;
    const detail = owner === undefined
      ? inspection.reason
      : `${owner.operation} (pid ${owner.pid}, since ${owner.createdAt})`;
    const action = inspection.status === "stale"
      ? "The owner is stale. Run branchlift doctor --fix, then retry."
      : "Wait for it to finish, or run branchlift doctor if the process crashed.";
    throw new BranchLiftError(
      `Another BranchLift operation owns ${scope}.`,
      `${detail}\n${action}`,
    );
  }

  try {
    try {
      await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { path, metadata };
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

export async function listLocks(repo: RepoInfo): Promise<LockInspection[]> {
  const root = lockRoot(repo);
  if (!(await pathExists(root))) return [];
  const locks: LockInspection[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
    locks.push(await inspectLock(join(root, entry.name)));
  }
  return locks.sort((left, right) => left.path.localeCompare(right.path));
}

export async function removeStaleLock(repo: RepoInfo, path: string): Promise<boolean> {
  const root = resolve(lockRoot(repo));
  const target = resolve(path);
  if (!target.startsWith(`${root}/`)) {
    throw new BranchLiftError(`Refusing to remove a lock outside BranchLift state: ${target}`);
  }
  if (!(await pathExists(target))) return false;
  const inspection = await inspectLock(target);
  if (inspection.status !== "stale") return false;
  await unlink(target);
  return true;
}

export function lockPath(repo: RepoInfo, scope: string): string {
  return join(lockRoot(repo), `${safeSlug(scope)}.lock`);
}

export function instanceLockScope(branch: string): string {
  return `instance:${branch}`;
}

export function snapshotLockScope(name: string): string {
  return `snapshot:${name}`;
}

function lockRoot(repo: RepoInfo): string {
  return join(repoDataRoot(repo), "locks");
}

async function releaseLock(path: string, token: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const metadata = await readMetadata(path);
  if (metadata?.token !== token) return;
  await unlink(path).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  });
}

async function inspectLock(path: string): Promise<LockInspection> {
  const fileStat = await stat(path);
  const ageMs = Math.max(0, Date.now() - fileStat.mtimeMs);
  const metadata = await readMetadata(path);
  if (metadata === undefined) {
    return ageMs >= incompleteLockGraceMs
      ? { path, status: "stale", reason: "Lock metadata is incomplete and old enough to recover." }
      : { path, status: "active", reason: "Lock acquisition is still being initialized." };
  }

  if (metadata.hostname !== hostname()) {
    return {
      path,
      metadata,
      status: "active",
      reason: `Owned by host ${metadata.hostname}; liveness cannot be verified safely from this host.`,
    };
  }

  if (!isProcessAlive(metadata.pid)) {
    return { path, metadata, status: "stale", reason: `Owner process ${metadata.pid} is no longer running.` };
  }
  return { path, metadata, status: "active", reason: `Owner process ${metadata.pid} is running.` };
}

async function readMetadata(path: string): Promise<LockMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isLockMetadata(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isLockMetadata(value: unknown): value is LockMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.token === "string"
    && typeof record.scope === "string"
    && typeof record.operation === "string"
    && typeof record.pid === "number"
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.hostname === "string"
    && typeof record.createdAt === "string";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
