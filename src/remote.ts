import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectConfiguredCompose, loadConfig } from "./config.js";
import { BranchLiftError } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { discoverRepo } from "./git.js";
import { withLock } from "./lock.js";
import { verifySnapshotContent } from "./manifest.js";
import { branchliftHome, pathExists, readJson, repoDataRoot, snapshotRoot, writeJsonAtomic } from "./paths.js";
import { securityPolicyDigest, trustSecurityPolicy } from "./policy.js";
import { previewInstances } from "./preview.js";
import { runCommand } from "./process.js";
import { destroyInstance, resetInstance, spawnInstance, startInstance, stopInstance } from "./runtime.js";
import { listInstances, listSnapshots, readSnapshotMetadata } from "./state.js";
import type { RemoteDefinition, RepoInfo } from "./types.js";
import { version } from "./version.js";

const protocolVersion = 1;
const responsePrefix = "BRANCHLIFT/1 ";
const maximumWorkerRequestBytes = 64 * 1024;
const maximumWorkerResponseBytes = 4 * 1024 * 1024;
const maximumSetupOutputBytes = 1024 * 1024;

interface RemoteStore {
  version: 1;
  remotes: RemoteDefinition[];
}

export interface AddRemoteOptions {
  name: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  repoPath: string;
  binary?: string;
}

export type RemoteAction = "ping" | "list" | "preview" | "snapshots" | "snapshot-plan" | "trust" | "spawn" | "start" | "stop" | "reset" | "destroy";

export interface RemoteRequest {
  protocol: 1;
  id: string;
  action: RemoteAction;
  repoPath: string;
  branch?: string;
  snapshot?: string;
  start?: boolean;
  startPoint?: string;
  confirm?: string;
  manifestDigest?: string;
  digests?: string[];
  expectedCommit?: string;
  expectedPolicyDigest?: string;
}

interface RemoteResponse {
  protocol: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function remoteStorePath(): string {
  return resolve(branchliftHome(), "remotes.json");
}

export async function addRemote(options: AddRemoteOptions): Promise<RemoteDefinition> {
  const name = remoteName(options.name);
  const host = remoteHost(options.host);
  const port = options.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BranchLiftError("Remote port must be between 1 and 65535.");
  if (!isAbsolute(options.repoPath) || /[\0\r\n]/.test(options.repoPath)) {
    throw new BranchLiftError("Remote repository path must be an absolute path without control characters.");
  }
  const binary = options.binary ?? "branchlift";
  if (!/^[A-Za-z0-9_./-]+$/.test(binary) || binary.startsWith("-")) {
    throw new BranchLiftError("Remote BranchLift binary must be a safe command or absolute path.");
  }
  if (options.identityFile !== undefined && /[\0\r\n]/.test(options.identityFile)) {
    throw new BranchLiftError("SSH identity-file path contains control characters.");
  }
  const user = options.user === undefined ? undefined : remoteUser(options.user);
  const identityFile = options.identityFile === undefined ? undefined : resolveIdentity(options.identityFile);
  if (identityFile !== undefined && !(await pathExists(identityFile))) {
    throw new BranchLiftError(`SSH identity file not found: ${identityFile}`);
  }
  const store = await readRemoteStore();
  if (store.remotes.some((remote) => remote.name === name)) {
    throw new BranchLiftError(`Remote already exists: ${name}`, "Remove it first or choose another name.");
  }
  const remote: RemoteDefinition = {
    version: 1,
    name,
    host,
    ...(user === undefined ? {} : { user }),
    port,
    ...(identityFile === undefined ? {} : { identityFile }),
    repoPath: options.repoPath,
    binary,
    createdAt: new Date().toISOString(),
  };
  store.remotes.push(remote);
  await writeJsonAtomic(remoteStorePath(), store);
  return remote;
}

export async function listRemotes(): Promise<RemoteDefinition[]> {
  return (await readRemoteStore()).remotes.sort((left, right) => left.name.localeCompare(right.name));
}

export async function removeRemote(name: string): Promise<void> {
  const normalized = remoteName(name);
  const store = await readRemoteStore();
  const remaining = store.remotes.filter((remote) => remote.name !== normalized);
  if (remaining.length === store.remotes.length) throw new BranchLiftError(`Remote not found: ${normalized}`);
  await writeJsonAtomic(remoteStorePath(), { version: 1, remotes: remaining } satisfies RemoteStore);
}

export async function getRemote(name: string): Promise<RemoteDefinition> {
  const normalized = remoteName(name);
  const remote = (await readRemoteStore()).remotes.find((candidate) => candidate.name === normalized);
  if (remote === undefined) throw new BranchLiftError(`Remote not found: ${normalized}`, "Run branchlift remote list.");
  return remote;
}

export async function callRemote(
  repo: RepoInfo,
  remoteNameValue: string,
  request: Omit<RemoteRequest, "protocol" | "id" | "repoPath">,
): Promise<unknown> {
  const remote = await getRemote(remoteNameValue);
  const id = randomUUID();
  const payload: RemoteRequest = { protocol: protocolVersion, id, repoPath: remote.repoPath, ...request };
  const destination = remoteDestination(remote);
  const args = remoteSshArguments(remote);
  args.push("--", destination, remote.binary, "worker");
  const result = await runCommand("ssh", args, {
    input: `${JSON.stringify(payload)}\n`,
    allowFailure: true,
    maxOutputBytes: maximumWorkerResponseBytes,
  });
  const response = parseRemoteResponse(result.stdout, id);
  if (response === undefined) {
    throw new BranchLiftError(
      `Remote ${remote.name} did not return a valid BranchLift worker response.`,
      result.stderr.trim() || result.stdout.trim() || `ssh exited ${result.exitCode}`,
    );
  }
  if (!response.ok) throw new BranchLiftError(`Remote ${remote.name} rejected ${request.action}.`, response.error);
  await recordEventBestEffort(repo, `remote.${request.action}`, `Remote ${remote.name} completed ${request.action}.`, {
    ...(request.branch === undefined ? {} : { branch: request.branch }),
    ...(request.snapshot === undefined ? {} : { snapshot: request.snapshot }),
    details: { remote: remote.name },
  });
  return response.result;
}

export async function setupRemote(repo: RepoInfo, name: string): Promise<RemoteDefinition> {
  const remote = await getRemote(name);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const temporary = await mkdtemp(resolve(tmpdir(), "branchlift-remote-setup-"));
  try {
    const packed = await runCommand("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporary,
      packageRoot,
    ], { allowFailure: true });
    if (packed.exitCode !== 0) {
      throw new BranchLiftError("Could not build the BranchLift remote worker package.", packed.stderr.trim());
    }
    const entries = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
    const filename = entries[0]?.filename;
    if (typeof filename !== "string" || filename.includes("/") || filename.includes("\\")) {
      throw new BranchLiftError("npm returned an invalid BranchLift package filename.");
    }
    const archive = await readFile(resolve(temporary, filename));
    if (archive.byteLength > 25 * 1024 * 1024) {
      throw new BranchLiftError("Remote worker package exceeds the 25 MiB transfer safety limit.");
    }
    const script = remoteSetupScript(archive.toString("base64"));
    const destination = remoteDestination(remote);
    const args = remoteSshArguments(remote);
    args.push("--", destination, "sh", "-s");
    const installed = await runCommand("ssh", args, {
      input: script,
      allowFailure: true,
      maxOutputBytes: maximumSetupOutputBytes,
    });
    if (installed.exitCode !== 0) {
      throw new BranchLiftError(
        `Remote worker setup failed on ${remote.name}.`,
        installed.stderr.trim() || installed.stdout.trim() || `ssh exited ${installed.exitCode}`,
      );
    }
    const marker = installed.stdout.split("\n").find((line) => line.startsWith("BRANCHLIFT-SETUP/1 "));
    const binary = marker?.slice("BRANCHLIFT-SETUP/1 ".length).trim();
    if (binary === undefined || !isAbsolute(binary) || !isSafeRemoteBinary(binary)) {
      throw new BranchLiftError(`Remote ${remote.name} did not return a valid installed worker path.`);
    }
    const updated: RemoteDefinition = {
      ...remote,
      binary,
      managedBinary: true,
      lastSetupAt: new Date().toISOString(),
    };
    await replaceRemote(updated);
    await recordEventBestEffort(repo, "remote.setup", `Installed BranchLift ${version} worker on ${remote.name}.`, {
      details: { remote: remote.name, version },
    });
    await callRemote(repo, remote.name, { action: "ping" });
    return updated;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runRemoteWorker(): Promise<number> {
  let requestId = "unknown";
  try {
    const raw = await readWorkerInput();
    const request = parseWorkerRequest(JSON.parse(raw) as unknown);
    requestId = request.id;
    if (request.action === "ping") {
      const repositoryReady = await pathExists(request.repoPath);
      writeWorkerResponse({
        protocol: protocolVersion,
        id: request.id,
        ok: true,
        result: {
          version,
          protocol: protocolVersion,
          host: hostname(),
          platform: process.platform,
          repository: repositoryReady ? await realRepositoryPath(request.repoPath) : request.repoPath,
          repositoryReady,
        },
      });
      return 0;
    }
    process.chdir(request.repoPath);
    const repo = await discoverRepo();
    const result = await withLock(repo, "remote-workspace", `remote ${request.action}`, async () => await executeWorkerAction(repo, request));
    writeWorkerResponse({ protocol: protocolVersion, id: request.id, ok: true, result });
    return 0;
  } catch (error) {
    writeWorkerResponse({
      protocol: protocolVersion,
      id: requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

async function realRepositoryPath(path: string): Promise<string> {
  const repo = await discoverRepo(path);
  return repo.root;
}

async function executeWorkerAction(repo: RepoInfo, request: RemoteRequest): Promise<unknown> {
  if (request.action === "list") return await listInstances(repo);
  if (request.action === "preview") return await previewInstances(repo, request.branch);
  if (request.action === "snapshots") return await listSnapshots(repo);
  if (request.action === "snapshot-plan") return await snapshotTransferPlan(repo, request);
  const config = await loadConfig(repo);
  await assertExpectedRemoteContext(repo, config, request);
  if (request.action === "trust") return await trustSecurityPolicy(repo, config);
  const inspection = await inspectConfiguredCompose(repo, config);
  const branch = requireRequestBranch(request);
  if (request.action === "spawn") {
    return await spawnInstance(repo, config, inspection, branch, {
      snapshot: request.snapshot ?? config.snapshot.default,
      start: request.start ?? true,
      agentCommand: [],
      quiet: true,
      ...(request.startPoint === undefined ? {} : { startPoint: request.startPoint }),
    });
  }
  if (request.action === "start") return await startInstance(repo, config, inspection, branch, { agentCommand: [], quiet: true });
  if (request.action === "stop") return await stopInstance(repo, branch);
  if (request.action === "reset") {
    assertRemoteConfirmation(request, branch);
    return await resetInstance(repo, config, inspection, branch, request.start ?? true);
  }
  if (request.action === "destroy") {
    assertRemoteConfirmation(request, branch);
    return await destroyInstance(repo, branch, false);
  }
  throw new BranchLiftError(`Unsupported worker action: ${request.action}`);
}

function parseWorkerRequest(value: unknown): RemoteRequest {
  if (!isRecord(value) || value.protocol !== protocolVersion || typeof value.id !== "string") {
    throw new BranchLiftError("Invalid remote worker request.");
  }
  const allowedActions: RemoteAction[] = ["ping", "list", "preview", "snapshots", "snapshot-plan", "trust", "spawn", "start", "stop", "reset", "destroy"];
  if (typeof value.action !== "string" || !allowedActions.includes(value.action as RemoteAction)) {
    throw new BranchLiftError("Unsupported remote worker action.");
  }
  if (typeof value.repoPath !== "string" || !isAbsolute(value.repoPath) || /[\0\r\n]/.test(value.repoPath)) {
    throw new BranchLiftError("Invalid remote repository path.");
  }
  const allowedKeys = new Set(["protocol", "id", "action", "repoPath", "branch", "snapshot", "start", "startPoint", "confirm", "manifestDigest", "digests", "expectedCommit", "expectedPolicyDigest"]);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) throw new BranchLiftError(`Unexpected remote request field: ${unexpected}`);
  return {
    protocol: 1,
    id: value.id,
    action: value.action as RemoteAction,
    repoPath: value.repoPath,
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.snapshot === "string" ? { snapshot: value.snapshot } : {}),
    ...(typeof value.start === "boolean" ? { start: value.start } : {}),
    ...(typeof value.startPoint === "string" ? { startPoint: validatedStartPoint(value.startPoint) } : {}),
    ...(typeof value.confirm === "string" ? { confirm: value.confirm } : {}),
    ...(typeof value.manifestDigest === "string" ? { manifestDigest: value.manifestDigest } : {}),
    ...(typeof value.expectedCommit === "string" ? { expectedCommit: validatedExpectedCommit(value.expectedCommit) } : {}),
    ...(typeof value.expectedPolicyDigest === "string" ? { expectedPolicyDigest: validatedExpectedDigest(value.expectedPolicyDigest) } : {}),
    ...(Array.isArray(value.digests) ? { digests: value.digests.map((digest) => {
      if (typeof digest !== "string") throw new BranchLiftError("Invalid remote blob digest.");
      return digest;
    }) } : {}),
  };
}

async function assertExpectedRemoteContext(repo: RepoInfo, config: Awaited<ReturnType<typeof loadConfig>>, request: RemoteRequest): Promise<void> {
  if (request.expectedCommit !== undefined) {
    const current = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
    if (current !== request.expectedCommit) {
      throw new BranchLiftError("Remote checkout changed after synchronization; refusing to continue.");
    }
  }
  if (request.expectedPolicyDigest !== undefined && securityPolicyDigest(config) !== request.expectedPolicyDigest) {
    throw new BranchLiftError("Remote execution policy differs from the synchronized policy; refusing to continue.");
  }
}

function validatedExpectedCommit(value: string): string {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new BranchLiftError("Invalid expected remote commit.");
  return value;
}

function validatedStartPoint(value: string): string {
  if (value.length === 0 || value.length > 300 || value.startsWith("-")
    || !/^[A-Za-z0-9][A-Za-z0-9/._@+-]*$/.test(value)) {
    throw new BranchLiftError("Invalid remote start point.");
  }
  return value;
}

function validatedExpectedDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new BranchLiftError("Invalid expected remote policy digest.");
  return value;
}

async function snapshotTransferPlan(repo: RepoInfo, request: RemoteRequest): Promise<unknown> {
  if (request.snapshot === undefined || request.manifestDigest === undefined || request.digests === undefined) {
    throw new BranchLiftError("snapshot-plan requires a snapshot, manifest digest, and digest list.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(request.manifestDigest)
    || request.digests.length > 400
    || request.digests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) {
    throw new BranchLiftError("snapshot-plan contains invalid SHA-256 digests.");
  }
  let alreadyPresent = false;
  const existingRoot = snapshotRoot(repo, request.snapshot);
  if (await pathExists(existingRoot)) {
    const metadata = await readSnapshotMetadata(repo, request.snapshot);
    if (metadata.contentDigest !== request.manifestDigest) {
      throw new BranchLiftError(`Remote snapshot ${request.snapshot} already exists with different content.`);
    }
    await verifySnapshotContent(repo, request.snapshot, request.manifestDigest);
    alreadyPresent = true;
  }
  const blobRoot = join(repoDataRoot(repo), "blobs", "sha256");
  const missing: string[] = [];
  for (const digest of request.digests) {
    if (!(await pathExists(join(blobRoot, digest.slice("sha256:".length))))) missing.push(digest);
  }
  return { alreadyPresent, missing };
}

function parseRemoteResponse(stdout: string, expectedId: string): RemoteResponse | undefined {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.startsWith(responsePrefix)) continue;
    try {
      const decoded = Buffer.from(line.slice(responsePrefix.length), "base64url").toString("utf8");
      const value = JSON.parse(decoded) as unknown;
      if (!isRecord(value) || value.protocol !== 1 || value.id !== expectedId || typeof value.ok !== "boolean") return undefined;
      return value as unknown as RemoteResponse;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function writeWorkerResponse(response: RemoteResponse): void {
  process.stdout.write(`${responsePrefix}${Buffer.from(JSON.stringify(response)).toString("base64url")}\n`);
}

async function readWorkerInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > maximumWorkerRequestBytes) throw new BranchLiftError("Remote worker request exceeds 64 KiB.");
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value === "") throw new BranchLiftError("Remote worker request is empty.");
  return value;
}

async function readRemoteStore(): Promise<RemoteStore> {
  if (!(await pathExists(remoteStorePath()))) return { version: 1, remotes: [] };
  const value = await readJson<unknown>(remoteStorePath());
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.remotes)) {
    throw new BranchLiftError(`Remote configuration is invalid: ${remoteStorePath()}`);
  }
  const remotes = value.remotes.map(parseRemoteDefinition);
  return { version: 1, remotes };
}

function parseRemoteDefinition(value: unknown): RemoteDefinition {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.name !== "string"
    || typeof value.host !== "string"
    || typeof value.port !== "number"
    || typeof value.repoPath !== "string"
    || typeof value.binary !== "string"
    || typeof value.createdAt !== "string") {
    throw new BranchLiftError("Remote entry is invalid.");
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new BranchLiftError("Remote entry has an invalid SSH port.");
  }
  if (!isAbsolute(value.repoPath) || /[\0\r\n]/.test(value.repoPath)) {
    throw new BranchLiftError("Remote entry has an invalid repository path.");
  }
  if (!isSafeRemoteBinary(value.binary)) throw new BranchLiftError("Remote entry has an unsafe worker binary.");
  if (typeof value.identityFile === "string" && /[\0\r\n]/.test(value.identityFile)) {
    throw new BranchLiftError("Remote entry has an invalid identity-file path.");
  }
  return {
    version: 1,
    name: remoteName(value.name),
    host: remoteHost(value.host),
    ...(typeof value.user === "string" ? { user: remoteUser(value.user) } : {}),
    port: value.port,
    ...(typeof value.identityFile === "string" ? { identityFile: value.identityFile } : {}),
    repoPath: value.repoPath,
    binary: value.binary,
    ...(typeof value.managedBinary === "boolean" ? { managedBinary: value.managedBinary } : {}),
    ...(typeof value.lastSetupAt === "string" ? { lastSetupAt: value.lastSetupAt } : {}),
    createdAt: value.createdAt,
  };
}

async function replaceRemote(remote: RemoteDefinition): Promise<void> {
  const store = await readRemoteStore();
  const index = store.remotes.findIndex((candidate) => candidate.name === remote.name);
  if (index < 0) throw new BranchLiftError(`Remote not found: ${remote.name}`);
  store.remotes[index] = remote;
  await writeJsonAtomic(remoteStorePath(), store);
}

export function remoteSshArguments(remote: RemoteDefinition): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
    "-p",
    String(remote.port),
  ];
  if (remote.identityFile !== undefined) args.push("-o", "IdentitiesOnly=yes", "-i", remote.identityFile);
  return args;
}

export function remoteSshInteractiveArguments(remote: RemoteDefinition): string[] {
  const args = remoteSshArguments(remote);
  args[0] = process.stdin.isTTY && process.stdout.isTTY ? "-tt" : "-T";
  return args;
}

export function remoteDestination(remote: RemoteDefinition): string {
  return remote.user === undefined ? remote.host : `${remote.user}@${remote.host}`;
}

function remoteSetupScript(packageBase64: string): string {
  return `set -eu
umask 077
command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required on the remote host." >&2; exit 20; }
command -v npm >/dev/null 2>&1 || { echo "npm is required on the remote host." >&2; exit 21; }
major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$major" -ge 22 ] || { echo "Node.js 22+ is required on the remote host." >&2; exit 22; }
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="$temporary/branchlift.tgz"
node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],Buffer.from(fs.readFileSync(0,"utf8").trim(),"base64"),{mode:384})' "$archive" <<'BRANCHLIFT_BUNDLE'
${packageBase64}
BRANCHLIFT_BUNDLE
prefix="$HOME/.local/share/branchlift/${version}"
mkdir -p "$prefix"
npm install --ignore-scripts --omit=dev --no-audit --no-fund --prefix "$prefix" "$archive" >/dev/null
binary="$prefix/node_modules/.bin/branchlift"
[ -x "$binary" ] || { echo "Installed package did not provide the BranchLift binary." >&2; exit 23; }
"$binary" --version >/dev/null
printf 'BRANCHLIFT-SETUP/1 %s\n' "$binary"
`;
}

function remoteName(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(value)) throw new BranchLiftError("Remote name must be 1-48 safe characters.");
  return value;
}

function remoteHost(value: string): string {
  if (value.trim() === "" || value.startsWith("-") || /[\s\0@]/.test(value)) throw new BranchLiftError("Remote host is invalid.");
  return value;
}

function remoteUser(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(value)) throw new BranchLiftError("Remote SSH user is invalid.");
  return value;
}

function resolveIdentity(value: string): string {
  if (value === "~") return resolve(process.env.HOME ?? "");
  if (value.startsWith("~/")) return resolve(process.env.HOME ?? "", value.slice(2));
  return resolve(value);
}

function isSafeRemoteBinary(value: string): boolean {
  return /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("-") && !/[\0\r\n]/.test(value);
}

function requireRequestBranch(request: RemoteRequest): string {
  if (request.branch === undefined || request.branch.trim() === "" || request.branch.length > 300) {
    throw new BranchLiftError(`${request.action} requires a branch.`);
  }
  return request.branch;
}

function assertRemoteConfirmation(request: RemoteRequest, branch: string): void {
  if (request.confirm !== branch) throw new BranchLiftError(`${request.action} confirmation must match the branch.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
