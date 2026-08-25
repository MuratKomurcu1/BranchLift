import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { effectiveSecurity, loadConfig } from "./config.js";
import { BranchLiftError } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { discoverRepo } from "./git.js";
import { withLock } from "./lock.js";
import { pathExists, readJson, repoDataRoot, safeSlug, writeJsonAtomic } from "./paths.js";
import { assertSecurityPolicyTrusted, securityPolicyDigest } from "./policy.js";
import { runCommand } from "./process.js";
import {
  callRemote,
  getRemote,
  remoteDestination,
  remoteSshArguments,
  remoteSshInteractiveArguments,
} from "./remote.js";
import { runSandbox } from "./sandbox.js";
import { readInstanceMetadata } from "./state.js";
import type { BranchLiftConfig, CommandResult, PublishedPort, RemoteDefinition, RepoInfo, SandboxNetwork } from "./types.js";

const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maximumEncodedRequestBytes = 64 * 1024;

export interface TunnelMapping {
  service: string;
  target: number;
  localHost: "127.0.0.1";
  localPort: number;
  remoteHost: "127.0.0.1" | "::1";
  remotePort: number;
}

export interface TunnelState {
  version: 1;
  remote: string;
  branch: string;
  controlPath: string;
  createdAt: string;
  mappings: TunnelMapping[];
}

export interface TunnelMonitorOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  onRestart?: (state: TunnelState) => void;
}

interface RemoteSessionRequest {
  protocol: 1;
  kind: "session";
  repoPath: string;
  branch: string;
  command: string[];
  expectedCommit: string;
  expectedPolicyDigest: string;
  network: SandboxNetwork;
  image?: string;
  writableWorktree: boolean;
}

interface RemoteBuildRequest {
  protocol: 1;
  kind: "build";
  repoPath: string;
  branch?: string;
  context: string;
  dockerfile: string;
  tag: string;
  expectedCommit: string;
  expectedPolicyDigest: string;
  network: "default" | "none";
  noCache: boolean;
  cacheMax: string;
}

interface RemoteCacheRequest {
  protocol: 1;
  kind: "cache";
  repoPath: string;
  action: "inspect" | "prune";
  confirm?: "prune";
  expectedCommit: string;
  expectedPolicyDigest: string;
}

type RemoteDevRequest = RemoteSessionRequest | RemoteBuildRequest | RemoteCacheRequest;

export async function startRemoteTunnels(repo: RepoInfo, remoteName: string, branch: string): Promise<TunnelState> {
  return await startRemoteTunnelsInternal(repo, remoteName, branch);
}

async function startRemoteTunnelsInternal(
  repo: RepoInfo,
  remoteName: string,
  branch: string,
  preferred?: TunnelState,
): Promise<TunnelState> {
  const remote = await getRemote(remoteName);
  const existing = await inspectRemoteTunnel(repo, remoteName, branch);
  if (existing !== undefined) return existing;
  const instance = await remoteInstance(remoteName, repo, branch);
  const tcpPorts = instance.ports.filter((port) => port.protocol === "tcp");
  if (tcpPorts.length === 0) throw new BranchLiftError(`Remote instance ${branch} has no published TCP ports to tunnel.`);
  const preferredPorts = tcpPorts.map((port) => preferred?.mappings.find((mapping) => mapping.service === port.service && mapping.target === port.target)?.localPort);
  const localPorts = await availableLocalPorts(tcpPorts.length, preferredPorts);
  const mappings: TunnelMapping[] = tcpPorts.map((port, index) => {
    const localPort = localPorts[index];
    if (localPort === undefined) throw new BranchLiftError("Could not allocate all requested local tunnel ports.");
    return {
      service: port.service,
      target: port.target,
      localHost: "127.0.0.1",
      localPort,
      remoteHost: port.host === "::1" ? "::1" : "127.0.0.1",
      remotePort: port.port,
    };
  });
  const statePath = tunnelStatePath(repo, remoteName, branch);
  const controlPath = join(tmpdir(), `branchlift-${createHash("sha256").update(statePath).digest("hex").slice(0, 24)}.sock`);
  await rm(controlPath, { force: true });
  const args = remoteSshArguments(remote);
  args.push("-o", "ExitOnForwardFailure=yes", "-M", "-S", controlPath, "-f", "-N");
  for (const mapping of mappings) {
    const remoteHost = mapping.remoteHost === "::1" ? "[::1]" : mapping.remoteHost;
    args.push("-L", `${mapping.localHost}:${mapping.localPort}:${remoteHost}:${mapping.remotePort}`);
  }
  args.push("--", remoteDestination(remote));
  const started = await runCommand("ssh", args, { allowFailure: true, maxOutputBytes: 1024 * 1024 });
  if (started.exitCode !== 0) {
    await rm(controlPath, { force: true });
    throw new BranchLiftError(`Could not start SSH tunnels for ${remoteName}:${branch}.`, started.stderr.trim());
  }
  const state: TunnelState = { version: 1, remote: remoteName, branch, controlPath, createdAt: new Date().toISOString(), mappings };
  await writeJsonAtomic(statePath, state);
  await recordEventBestEffort(repo, "remote.tunnel.start", `Opened loopback SSH tunnels to ${remoteName}:${branch}.`, {
    branch,
    details: { remote: remoteName, mappings },
  });
  return state;
}

export async function inspectRemoteTunnel(repo: RepoInfo, remoteName: string, branch: string): Promise<TunnelState | undefined> {
  const path = tunnelStatePath(repo, remoteName, branch);
  if (!(await pathExists(path))) return undefined;
  const value = await readJson<unknown>(path);
  if (!isTunnelState(value) || value.remote !== remoteName || value.branch !== branch) {
    throw new BranchLiftError(`Tunnel state is invalid: ${path}`);
  }
  const remote = await getRemote(remoteName);
  if (!(await tunnelControl(remote, value.controlPath, "check"))) {
    await rm(path, { force: true });
    await rm(value.controlPath, { force: true });
    return undefined;
  }
  return value;
}

export async function stopRemoteTunnels(repo: RepoInfo, remoteName: string, branch: string): Promise<boolean> {
  const path = tunnelStatePath(repo, remoteName, branch);
  if (!(await pathExists(path))) return false;
  const value = await readJson<unknown>(path);
  if (!isTunnelState(value) || value.remote !== remoteName || value.branch !== branch) {
    throw new BranchLiftError(`Tunnel state is invalid: ${path}`);
  }
  const remote = await getRemote(remoteName);
  await tunnelControl(remote, value.controlPath, "exit");
  await rm(value.controlPath, { force: true });
  await rm(path, { force: true });
  await recordEventBestEffort(repo, "remote.tunnel.stop", `Closed SSH tunnels to ${remoteName}:${branch}.`, {
    branch,
    details: { remote: remoteName },
  });
  return true;
}

export async function monitorRemoteTunnels(
  repo: RepoInfo,
  remoteName: string,
  branch: string,
  options: TunnelMonitorOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) {
    throw new BranchLiftError("Tunnel monitor interval must be between 250 and 60000 milliseconds.");
  }
  while (!signalAborted(options.signal)) {
    await abortableDelay(intervalMs, options.signal);
    if (signalAborted(options.signal)) return;
    try {
      const previous = await readStoredTunnelState(repo, remoteName, branch);
      const state = await inspectRemoteTunnel(repo, remoteName, branch);
      if (state !== undefined && await tunnelListenersHealthy(state)) continue;
      if (state !== undefined) await stopRemoteTunnels(repo, remoteName, branch);
      const restarted = await startRemoteTunnelsInternal(repo, remoteName, branch, state ?? previous);
      options.onRestart?.(restarted);
      await recordEventBestEffort(repo, "remote.tunnel.recover", `Recovered SSH tunnels to ${remoteName}:${branch}.`, {
        branch,
        details: { remote: remoteName, mappings: restarted.mappings },
      });
    } catch (error) {
      process.stderr.write(`SSH tunnel recovery failed for ${remoteName}:${branch}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runRemoteAgent(
  repo: RepoInfo,
  remoteName: string,
  branch: string,
  command: string[],
  options: { network?: SandboxNetwork; image?: string; writableWorktree?: boolean } = {},
): Promise<number> {
  if (command.length === 0) throw new BranchLiftError("Remote agent command must not be empty.");
  validateCommand(command);
  const remote = await getRemote(remoteName);
  const context = await expectedLocalContext(repo);
  const configuredNetwork = effectiveSecurity(await loadConfig(repo)).sandbox.network;
  const request: RemoteSessionRequest = {
    protocol: 1,
    kind: "session",
    repoPath: remote.repoPath,
    branch,
    command,
    expectedCommit: context.commit,
    expectedPolicyDigest: context.policyDigest,
    network: options.network ?? configuredNetwork,
    ...(options.image === undefined ? {} : { image: options.image }),
    writableWorktree: options.writableWorktree ?? true,
  };
  return await runRemoteDevCommand(remote, "session", request, true);
}

export async function runRemoteBuild(
  repo: RepoInfo,
  remoteName: string,
  options: { branch?: string; context?: string; dockerfile?: string; tag: string; network?: "default" | "none"; noCache?: boolean; cacheMax?: string },
): Promise<number> {
  const { remote, request } = await remoteBuildRequest(repo, remoteName, options);
  return await runRemoteDevCommand(remote, "build", request, false);
}

export async function runRemoteBuildCaptured(
  repo: RepoInfo,
  remoteName: string,
  options: { branch?: string; context?: string; dockerfile?: string; tag: string; network?: "default" | "none"; noCache?: boolean; cacheMax?: string },
): Promise<CommandResult> {
  const { remote, request } = await remoteBuildRequest(repo, remoteName, options);
  return await runRemoteDevCommandCaptured(remote, "build", request);
}

export async function runRemoteCache(
  repo: RepoInfo,
  remoteName: string,
  action: "inspect" | "prune",
  confirm?: "prune",
): Promise<number> {
  const { remote, request } = await remoteCacheRequest(repo, remoteName, action, confirm);
  return await runRemoteDevCommand(remote, "cache", request, false);
}

export async function runRemoteCacheCaptured(
  repo: RepoInfo,
  remoteName: string,
  action: "inspect" | "prune",
  confirm?: "prune",
): Promise<CommandResult> {
  const { remote, request } = await remoteCacheRequest(repo, remoteName, action, confirm);
  return await runRemoteDevCommandCaptured(remote, "cache", request);
}

export async function runRemoteSession(encoded: string): Promise<number> {
  const request = decodeRemoteDevRequest(encoded, "session");
  const { repo, config } = await loadAndVerifyRemoteContext(request);
  return await runSandbox(repo, config, request.branch, request.command, {
    backend: "docker",
    network: request.network,
    ...(request.image === undefined ? {} : { image: request.image }),
    writableWorktree: request.writableWorktree,
    interactive: true,
  });
}

export async function runRemoteBuildWorker(encoded: string): Promise<number> {
  const request = decodeRemoteDevRequest(encoded, "build");
  const { repo } = await loadAndVerifyRemoteContext(request);
  const root = request.branch === undefined
    ? repo.root
    : (await readInstanceMetadata(repo, safeSlug(request.branch))).worktreePath;
  const canonicalRoot = await realpath(root);
  const context = await safeBuildPath(canonicalRoot, request.context, "build context");
  const dockerfile = await safeBuildPath(canonicalRoot, request.dockerfile, "Dockerfile");
  const buildx = await runCommand("docker", ["buildx", "version"], { allowFailure: true, maxOutputBytes: 1024 * 1024 });
  if (buildx.exitCode !== 0) {
    throw new BranchLiftError("Remote BuildKit requires the free Docker Buildx plugin (docker buildx).", "Install Docker Buildx on the remote host and retry.");
  }
  return await withLock(repo, "remote-build-cache", "remote BuildKit build", async () => {
    const builder = await ensureBuildKitBuilder(repo);
    const args = ["buildx", "build", "--builder", builder, "--load", "--progress=plain"];
    args.push("--file", dockerfile, "--tag", request.tag, "--network", request.network);
    if (request.noCache) args.push("--no-cache");
    args.push(context);
    const result = await runCommand("docker", args, {
      stdio: "inherit",
      allowFailure: true,
      env: { ...process.env, DOCKER_BUILDKIT: "1", BUILDKIT_PROGRESS: "plain" },
    });
    let gcExitCode: number | null = null;
    if (result.exitCode === 0) {
      const gc = await runCommand("docker", ["buildx", "prune", "--builder", builder, "--force", "--max-used-space", request.cacheMax], {
        allowFailure: true,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      gcExitCode = gc.exitCode;
      if (gc.exitCode !== 0) process.stderr.write(`warning: BuildKit cache cap could not be applied: ${gc.stderr.trim()}\n`);
    }
    await recordEventBestEffort(repo, "remote.build", `Remote BuildKit build ${result.exitCode === 0 ? "completed" : "failed"}.`, {
      level: result.exitCode === 0 ? "info" : "error",
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      details: { tag: request.tag, builder, network: request.network, noCache: request.noCache, cacheMax: request.cacheMax, gcExitCode, exitCode: result.exitCode },
    });
    if (result.exitCode === 0) {
      process.stdout.write(`BRANCHLIFT-BUILD/1 ${Buffer.from(JSON.stringify({
        tag: request.tag,
        branch: request.branch ?? null,
        builder: "docker-buildx-buildkit",
        builderName: builder,
        cache: request.noCache ? "read-bypassed" : "persistent-scoped-builder",
        cacheMax: request.cacheMax,
        cacheGcApplied: gcExitCode === 0,
      })).toString("base64url")}\n`);
    }
    return result.exitCode;
  });
}

export async function runRemoteCacheWorker(encoded: string): Promise<number> {
  const request = decodeRemoteDevRequest(encoded, "cache");
  const { repo } = await loadAndVerifyRemoteContext(request);
  if (request.action === "prune" && request.confirm !== "prune") {
    throw new BranchLiftError("Remote build-cache prune requires exact confirmation: prune");
  }
  return await withLock(repo, "remote-build-cache", `remote build-cache ${request.action}`, async () => {
    const builder = buildKitBuilderName(repo);
    const inspection = await runCommand("docker", ["buildx", "inspect", builder], { allowFailure: true, maxOutputBytes: 1024 * 1024 });
    const available = inspection.exitCode === 0;
    if (available) assertBuildKitBuilderDriver(builder, inspection);
    let exitCode = 0;
    if (available) {
      const args = request.action === "inspect"
        ? ["buildx", "du", "--builder", builder]
        : ["buildx", "prune", "--builder", builder, "--force"];
      exitCode = (await runCommand("docker", args, { stdio: "inherit", allowFailure: true })).exitCode;
    }
    const result = { action: request.action, builder, available, exitCode };
    process.stdout.write(`BRANCHLIFT-CACHE/1 ${Buffer.from(JSON.stringify(result)).toString("base64url")}\n`);
    await recordEventBestEffort(repo, `remote.cache.${request.action}`, `Remote scoped BuildKit cache ${request.action === "prune" ? "pruned" : "inspected"}.`, {
      details: result,
    });
    return exitCode;
  });
}

async function remoteBuildRequest(
  repo: RepoInfo,
  remoteName: string,
  options: { branch?: string; context?: string; dockerfile?: string; tag: string; network?: "default" | "none"; noCache?: boolean; cacheMax?: string },
): Promise<{ remote: RemoteDefinition; request: RemoteBuildRequest }> {
  const remote = await getRemote(remoteName);
  const expected = await expectedLocalContext(repo);
  return {
    remote,
    request: {
      protocol: 1,
      kind: "build",
      repoPath: remote.repoPath,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      context: options.context ?? ".",
      dockerfile: options.dockerfile ?? "Dockerfile",
      tag: validatedImageTag(options.tag),
      expectedCommit: expected.commit,
      expectedPolicyDigest: expected.policyDigest,
      network: options.network ?? "default",
      noCache: options.noCache ?? false,
      cacheMax: validatedCacheSize(options.cacheMax ?? "20gb"),
    },
  };
}

async function remoteCacheRequest(
  repo: RepoInfo,
  remoteName: string,
  action: "inspect" | "prune",
  confirm?: "prune",
): Promise<{ remote: RemoteDefinition; request: RemoteCacheRequest }> {
  const remote = await getRemote(remoteName);
  const expected = await expectedLocalContext(repo);
  return {
    remote,
    request: {
      protocol: 1,
      kind: "cache",
      repoPath: remote.repoPath,
      action,
      ...(confirm === undefined ? {} : { confirm }),
      expectedCommit: expected.commit,
      expectedPolicyDigest: expected.policyDigest,
    },
  };
}

function buildKitBuilderName(repo: RepoInfo): string {
  return `branchlift-${createHash("sha256").update(repo.key).digest("hex").slice(0, 16)}`;
}

async function ensureBuildKitBuilder(repo: RepoInfo): Promise<string> {
  const name = buildKitBuilderName(repo);
  const inspection = await runCommand("docker", ["buildx", "inspect", name], { allowFailure: true, maxOutputBytes: 1024 * 1024 });
  if (inspection.exitCode === 0) assertBuildKitBuilderDriver(name, inspection);
  else {
    const created = await runCommand("docker", ["buildx", "create", "--name", name, "--driver", "docker-container"], {
      allowFailure: true,
      maxOutputBytes: 1024 * 1024,
    });
    if (created.exitCode !== 0) {
      const raced = await runCommand("docker", ["buildx", "inspect", name], { allowFailure: true, maxOutputBytes: 1024 * 1024 });
      if (raced.exitCode !== 0) throw new BranchLiftError(`Could not create the scoped BuildKit builder ${name}.`, created.stderr.trim());
      assertBuildKitBuilderDriver(name, raced);
    }
  }
  const bootstrapped = await runCommand("docker", ["buildx", "inspect", "--bootstrap", name], {
    allowFailure: true,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (bootstrapped.exitCode !== 0) throw new BranchLiftError(`Could not start the scoped BuildKit builder ${name}.`, bootstrapped.stderr.trim());
  assertBuildKitBuilderDriver(name, bootstrapped);
  return name;
}

function assertBuildKitBuilderDriver(name: string, inspection: CommandResult): void {
  if (!/^Driver:\s+docker-container\s*$/im.test(inspection.stdout)) {
    throw new BranchLiftError(`BuildKit builder ${name} exists with an unexpected driver.`, "BranchLift will not use or prune a builder it did not provision with the docker-container driver.");
  }
}

async function loadAndVerifyRemoteContext(request: RemoteDevRequest): Promise<{ repo: RepoInfo; config: BranchLiftConfig }> {
  process.chdir(request.repoPath);
  const repo = await discoverRepo();
  const config = await loadConfig(repo);
  const current = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
  if (current !== request.expectedCommit) throw new BranchLiftError("Remote checkout differs from the requested development commit.");
  if (securityPolicyDigest(config) !== request.expectedPolicyDigest) throw new BranchLiftError("Remote policy differs from the requested development policy.");
  await assertSecurityPolicyTrusted(repo, config);
  return { repo, config };
}

async function runRemoteDevCommand(remote: RemoteDefinition, command: "session" | "build" | "cache", request: RemoteDevRequest, interactive: boolean): Promise<number> {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  if (encoded.length > maximumEncodedRequestBytes || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new BranchLiftError("Remote development request exceeds its safety limit.");
  }
  const args = interactive ? remoteSshInteractiveArguments(remote) : remoteSshArguments(remote);
  args.push("--", remoteDestination(remote), remote.binary, command, encoded);
  const child = spawn("ssh", args, { stdio: "inherit", shell: false });
  return await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

async function runRemoteDevCommandCaptured(
  remote: RemoteDefinition,
  command: "build" | "cache",
  request: RemoteBuildRequest | RemoteCacheRequest,
): Promise<CommandResult> {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  if (encoded.length > maximumEncodedRequestBytes || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new BranchLiftError("Remote development request exceeds its safety limit.");
  }
  const args = remoteSshArguments(remote);
  args.push("--", remoteDestination(remote), remote.binary, command, encoded);
  return await runCommand("ssh", args, { allowFailure: true, maxOutputBytes: 4 * 1024 * 1024 });
}

function decodeRemoteDevRequest<T extends RemoteDevRequest["kind"]>(encoded: string, expectedKind: T): Extract<RemoteDevRequest, { kind: T }> {
  if (encoded.length === 0 || encoded.length > maximumEncodedRequestBytes || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new BranchLiftError("Invalid remote development request encoding.");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new BranchLiftError("Remote development request is not valid JSON.");
  }
  if (!isRecord(value) || value.protocol !== 1 || value.kind !== expectedKind
    || typeof value.repoPath !== "string" || !isAbsolute(value.repoPath) || /[\0\r\n]/.test(value.repoPath)
    || typeof value.expectedCommit !== "string" || !commitPattern.test(value.expectedCommit)
    || typeof value.expectedPolicyDigest !== "string" || !digestPattern.test(value.expectedPolicyDigest)) {
    throw new BranchLiftError("Remote development request is invalid.");
  }
  if (expectedKind === "session") validateSessionRequest(value);
  else if (expectedKind === "build") validateBuildRequest(value);
  else validateCacheRequest(value);
  return value as unknown as Extract<RemoteDevRequest, { kind: T }>;
}

function validateSessionRequest(value: Record<string, unknown>): void {
  assertOnlyKeys(value, ["protocol", "kind", "repoPath", "branch", "command", "expectedCommit", "expectedPolicyDigest", "network", "image", "writableWorktree"]);
  if (typeof value.branch !== "string" || value.branch.trim() === "" || value.branch.length > 300
    || !Array.isArray(value.command) || value.command.some((item) => typeof item !== "string")
    || !["none", "backend", "outbound"].includes(String(value.network))
    || typeof value.writableWorktree !== "boolean"
    || (value.image !== undefined && (typeof value.image !== "string" || value.image.length > 300))) {
    throw new BranchLiftError("Remote session request is invalid.");
  }
  validateCommand(value.command as string[]);
}

function validateBuildRequest(value: Record<string, unknown>): void {
  assertOnlyKeys(value, ["protocol", "kind", "repoPath", "branch", "context", "dockerfile", "tag", "expectedCommit", "expectedPolicyDigest", "network", "noCache", "cacheMax"]);
  if ((value.branch !== undefined && (typeof value.branch !== "string" || value.branch.trim() === "" || value.branch.length > 300))
    || typeof value.context !== "string" || !safeRelativeBuildPath(value.context)
    || typeof value.dockerfile !== "string" || !safeRelativeBuildPath(value.dockerfile)
    || typeof value.tag !== "string" || validatedImageTag(value.tag) !== value.tag
    || (value.network !== "default" && value.network !== "none") || typeof value.noCache !== "boolean"
    || typeof value.cacheMax !== "string" || validatedCacheSize(value.cacheMax) !== value.cacheMax) {
    throw new BranchLiftError("Remote build request is invalid.");
  }
}

function validateCacheRequest(value: Record<string, unknown>): void {
  assertOnlyKeys(value, ["protocol", "kind", "repoPath", "action", "confirm", "expectedCommit", "expectedPolicyDigest"]);
  if ((value.action !== "inspect" && value.action !== "prune") || (value.confirm !== undefined && value.confirm !== "prune")) {
    throw new BranchLiftError("Remote cache request is invalid.");
  }
}

async function expectedLocalContext(repo: RepoInfo): Promise<{ commit: string; policyDigest: string }> {
  const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: repo.root })).stdout.trim();
  if (!commitPattern.test(commit)) throw new BranchLiftError("Git returned an unsupported commit identifier.");
  return { commit, policyDigest: securityPolicyDigest(await loadConfig(repo)) };
}

async function remoteInstance(remoteName: string, repo: RepoInfo, branch: string): Promise<{ ports: PublishedPort[] }> {
  const result = await callRemote(repo, remoteName, { action: "list" });
  if (!Array.isArray(result)) throw new BranchLiftError(`Remote ${remoteName} returned an invalid instance list.`);
  const instance = result.find((item) => isRecord(item) && item.branch === branch);
  if (!isRecord(instance) || !Array.isArray(instance.ports)) throw new BranchLiftError(`Remote instance not found: ${branch}`);
  const ports = instance.ports.map((port) => {
    if (!isRecord(port) || typeof port.service !== "string" || port.service.length === 0 || port.service.length > 300 || /[\0\r\n]/.test(port.service)
      || !validTcpPort(port.target) || (port.protocol !== "tcp" && port.protocol !== "udp")
      || (port.host !== "127.0.0.1" && port.host !== "::1") || !validTcpPort(port.port)) {
      throw new BranchLiftError(`Remote ${remoteName} returned invalid port metadata.`);
    }
    return port as unknown as PublishedPort;
  });
  return { ports };
}

async function availableLocalPorts(count: number, preferred: Array<number | undefined> = []): Promise<number[]> {
  const servers: Array<ReturnType<typeof createServer>> = [];
  try {
    const ports: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const requested = preferred[index];
      let reservation: { server: ReturnType<typeof createServer>; port: number };
      try {
        reservation = await reserveLocalPort(requested ?? 0);
      } catch (error) {
        if (requested === undefined) throw error;
        reservation = await reserveLocalPort(0);
      }
      const { server, port } = reservation;
      servers.push(server);
      ports.push(port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map(async (server) => await new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  }
}

async function reserveLocalPort(port: number): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer();
  server.unref();
  try {
    const selected = await new Promise<number>((resolvePort, rejectPort) => {
      const onError = (error: Error): void => rejectPort(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") rejectPort(new BranchLiftError("Could not allocate a local tunnel port."));
        else resolvePort(address.port);
      });
    });
    return { server, port: selected };
  } catch (error) {
    if (server.listening) server.close();
    throw error;
  }
}

async function tunnelControl(remote: RemoteDefinition, controlPath: string, operation: "check" | "exit"): Promise<boolean> {
  if (!isAbsolute(controlPath) || /[\0\r\n]/.test(controlPath)) throw new BranchLiftError("Invalid SSH tunnel control path.");
  const args = remoteSshArguments(remote);
  args.push("-S", controlPath, "-O", operation, "--", remoteDestination(remote));
  const result = await runCommand("ssh", args, { allowFailure: true, maxOutputBytes: 1024 * 1024 });
  return result.exitCode === 0;
}

function tunnelStatePath(repo: RepoInfo, remote: string, branch: string): string {
  return join(repoDataRoot(repo), "remote-tunnels", `${safeSlug(`${remote}:${branch}`)}.json`);
}

async function readStoredTunnelState(repo: RepoInfo, remote: string, branch: string): Promise<TunnelState | undefined> {
  const path = tunnelStatePath(repo, remote, branch);
  if (!(await pathExists(path))) return undefined;
  const value = await readJson<unknown>(path);
  if (!isTunnelState(value) || value.remote !== remote || value.branch !== branch) {
    throw new BranchLiftError(`Tunnel state is invalid: ${path}`);
  }
  return value;
}

function isTunnelState(value: unknown): value is TunnelState {
  return isRecord(value) && value.version === 1 && typeof value.remote === "string" && typeof value.branch === "string"
    && typeof value.controlPath === "string" && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) && Array.isArray(value.mappings)
    && value.mappings.every((mapping) => isRecord(mapping) && typeof mapping.service === "string"
      && validTcpPort(mapping.target) && mapping.localHost === "127.0.0.1" && validTcpPort(mapping.localPort)
      && (mapping.remoteHost === "127.0.0.1" || mapping.remoteHost === "::1") && validTcpPort(mapping.remotePort));
}

function validTcpPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
}

async function tunnelListenersHealthy(state: TunnelState): Promise<boolean> {
  const results = await Promise.all(state.mappings.map(async (mapping) => await probeTcp(mapping.localHost, mapping.localPort)));
  return results.every(Boolean);
}

async function probeTcp(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (healthy: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(healthy);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    };
    timer = setTimeout(finish, milliseconds);
    if (signal?.aborted === true) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

async function safeBuildPath(root: string, value: string, label: string): Promise<string> {
  if (!safeRelativeBuildPath(value)) throw new BranchLiftError(`Invalid ${label} path.`);
  const candidate = resolve(root, value);
  if (!isWithin(root, candidate) || !(await pathExists(candidate))) throw new BranchLiftError(`${label} is missing or outside the remote worktree: ${value}`);
  const canonical = await realpath(candidate);
  if (!isWithin(root, canonical)) throw new BranchLiftError(`${label} resolves outside the remote worktree: ${value}`);
  return canonical;
}

function safeRelativeBuildPath(value: string): boolean {
  if (value === ".") return true;
  return value !== "" && !isAbsolute(value) && !value.includes("\\") && !/[\0\r\n]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validatedImageTag(value: string): string {
  if (value.length === 0 || value.length > 300 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value) || value.startsWith("-")) {
    throw new BranchLiftError("Remote build tag is invalid.");
  }
  return value;
}

function validatedCacheSize(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[1-9][0-9]{0,5}(?:kb|mb|gb|tb)$/.test(normalized)) {
    throw new BranchLiftError("Remote BuildKit cache cap must be a positive size such as 20gb.");
  }
  return normalized;
}

function validateCommand(command: string[]): void {
  if (command.length === 0 || command.length > 128 || command.some((item) => item.length === 0 || item.length > 4096 || /\0/.test(item))) {
    throw new BranchLiftError("Remote agent command is invalid or exceeds its safety limit.");
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 48 * 1024) throw new BranchLiftError("Remote agent command exceeds 48 KiB.");
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !keys.has(key));
  if (unexpected !== undefined) throw new BranchLiftError(`Unexpected remote development field: ${unexpected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
