import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BranchLiftError } from "./errors.js";
import { runCommand } from "./process.js";
import type { CopyStrategy, RepoInfo } from "./types.js";

export function branchliftHome(): string {
  const configured = process.env.BRANCHLIFT_HOME;
  return resolve(configured && configured.trim() !== "" ? configured : join(homedir(), ".branchlift"));
}

export function repoDataRoot(repo: RepoInfo): string {
  return join(branchliftHome(), "repos", repo.key);
}

export function snapshotRoot(repo: RepoInfo, name: string): string {
  return join(repoDataRoot(repo), "snapshots", safeSlug(name));
}

export function instanceRoot(repo: RepoInfo, slug: string): string {
  return join(repoDataRoot(repo), "instances", safeSlug(slug));
}

export function worktreeRoot(repo: RepoInfo, slug: string): string {
  return join(branchliftHome(), "worktrees", repo.key, safeSlug(slug));
}

export function safeSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  if (normalized === "") throw new BranchLiftError(`Cannot derive a safe name from: ${value}`);
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 7);
  return `${normalized}-${suffix}`;
}

export function repoKey(commonDir: string): string {
  return `${safeSlug(basename(dirname(commonDir)))}-${createHash("sha256").update(resolve(commonDir)).digest("hex").slice(0, 12)}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function createExclusiveDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new BranchLiftError(`Path already exists: ${path}`, "Choose another name or destroy the existing BranchLift runtime first.");
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true });
      await mkdir(path, { recursive: false });
      return;
    }
    throw error;
  }
}

export async function cloneDirectory(source: string, destination: string): Promise<CopyStrategy> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source);
  if (entries.length === 0) return "empty";

  if (process.platform === "darwin") {
    const result = await runCommand("cp", ["-cR", `${source}/.`, destination], { allowFailure: true });
    if (result.exitCode === 0) return "apfs-clone";
  }

  if (process.platform === "linux") {
    const result = await runCommand("cp", ["-a", "--reflink=always", `${source}/.`, destination], {
      allowFailure: true,
    });
    if (result.exitCode === 0) return "linux-reflink";
  }

  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  return "recursive-copy";
}

export async function directorySize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export async function copyPrivateFile(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const data = await readFile(source);
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
