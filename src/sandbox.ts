import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { effectiveSecurity } from "./config.js";
import { assertDockerReady, composeArgs } from "./docker.js";
import { BranchLiftError } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { instanceRoot, pathExists, safeSlug } from "./paths.js";
import { assertSecurityPolicyTrusted } from "./policy.js";
import { runCommand } from "./process.js";
import { instanceEnvironment, runtimeFromMetadata } from "./runtime.js";
import { mergeSecretEnvironment, resolveSecrets, writePlainSecretEnvFile } from "./secrets.js";
import { readInstanceMetadata } from "./state.js";
import type { BranchLiftConfig, InstanceMetadata, RepoInfo, SandboxBackend, SandboxNetwork } from "./types.js";

export interface SandboxRunOptions {
  backend?: SandboxBackend;
  image?: string;
  network?: SandboxNetwork;
  writableWorktree?: boolean;
  interactive?: boolean;
}

export interface SandboxPosture {
  backend: SandboxBackend;
  image: string;
  network: SandboxNetwork;
  hostDockerSocketMounted: false;
  readOnlyRoot: boolean;
  capabilities: "dropped" | "host-process";
  noNewPrivileges: boolean;
  resourceLimits: { memory: string; cpus: number; pids: number };
  boundary: "none" | "container";
  warnings: string[];
}

interface NetworkAttachment {
  network: string;
  containers: string[];
}

export function sandboxPosture(config: BranchLiftConfig, options: SandboxRunOptions = {}): SandboxPosture {
  const policy = effectiveSecurity(config);
  const backend = options.backend ?? policy.sandbox.backend;
  const network = options.network ?? policy.sandbox.network;
  const warnings: string[] = [];
  if (backend === "host") warnings.push("Host mode is not a security boundary and is disabled unless explicitly allowed.");
  if (network === "outbound") warnings.push("Outbound mode permits network egress; prefer backend or none for untrusted tasks.");
  if (options.writableWorktree !== false) warnings.push("The selected worktree is writable by the sandboxed command.");
  return {
    backend,
    image: options.image ?? policy.sandbox.image,
    network,
    hostDockerSocketMounted: false,
    readOnlyRoot: backend === "docker" ? policy.sandbox.readOnlyRoot : false,
    capabilities: backend === "docker" ? "dropped" : "host-process",
    noNewPrivileges: backend === "docker",
    resourceLimits: {
      memory: policy.sandbox.memory,
      cpus: policy.sandbox.cpus,
      pids: policy.sandbox.pidsLimit,
    },
    boundary: backend === "docker" ? "container" : "none",
    warnings,
  };
}

export async function runSandbox(
  repo: RepoInfo,
  config: BranchLiftConfig,
  branch: string,
  command: string[],
  options: SandboxRunOptions = {},
): Promise<number> {
  if (command.length === 0) throw new BranchLiftError("Sandbox command must not be empty.");
  await assertSecurityPolicyTrusted(repo, config);
  const metadata = await readInstanceMetadata(repo, safeSlug(branch));
  if (!(await pathExists(metadata.worktreePath))) throw new BranchLiftError(`Worktree is missing: ${metadata.worktreePath}`);
  const posture = sandboxPosture(config, options);
  await recordEventBestEffort(repo, "sandbox.start", `Starting ${posture.backend} sandbox for ${branch}.`, {
    branch,
    snapshot: metadata.snapshot,
    details: { backend: posture.backend, network: posture.network, image: posture.image, command: command[0] },
  });
  let exitCode: number;
  try {
    exitCode = posture.backend === "host"
      ? await runHostSandbox(repo, config, metadata, command)
      : await runDockerSandbox(repo, config, metadata, command, posture, options.writableWorktree !== false, options.interactive === true);
  } catch (error) {
    await recordEventBestEffort(repo, "sandbox.failure", `Sandbox failed for ${branch}.`, {
      level: "error",
      branch,
      snapshot: metadata.snapshot,
      details: { backend: posture.backend, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
  await recordEventBestEffort(repo, "sandbox.complete", `Sandbox completed for ${branch}.`, {
    branch,
    snapshot: metadata.snapshot,
    details: { backend: posture.backend, exitCode },
  });
  return exitCode;
}

async function runHostSandbox(
  repo: RepoInfo,
  config: BranchLiftConfig,
  metadata: InstanceMetadata,
  command: string[],
): Promise<number> {
  if (!effectiveSecurity(config).allowHostAgentCommands) {
    throw new BranchLiftError(
      "Host sandbox mode is disabled by policy because it provides no isolation.",
      "Use the docker backend or explicitly set security.allowHostAgentCommands: true.",
    );
  }
  const [executable, ...args] = command;
  if (executable === undefined) throw new BranchLiftError("Sandbox command must not be empty.");
  const contextFile = join(instanceRoot(repo, metadata.slug), "context.json");
  const secrets = await resolveSecrets(repo, config, "sandbox");
  const result = await runCommand(executable, args, {
    cwd: metadata.worktreePath,
    stdio: "inherit",
    allowFailure: true,
    env: mergeSecretEnvironment(instanceEnvironment(metadata, contextFile), secrets),
  });
  return result.exitCode;
}

async function runDockerSandbox(
  repo: RepoInfo,
  config: BranchLiftConfig,
  metadata: InstanceMetadata,
  command: string[],
  posture: SandboxPosture,
  writableWorktree: boolean,
  interactive: boolean,
): Promise<number> {
  await assertDockerReady();
  assertDockerReference(posture.image);
  assertMountablePath(metadata.worktreePath);
  const imageCheck = await runCommand("docker", ["image", "inspect", posture.image], { allowFailure: true });
  if (imageCheck.exitCode !== 0) {
    throw new BranchLiftError(
      `Sandbox image is not present locally: ${posture.image}`,
      `Review and pull it explicitly with: docker pull ${posture.image}`,
    );
  }
  const policy = effectiveSecurity(config).sandbox;
  const sandboxId = randomUUID();
  const shortId = sandboxId.slice(0, 12);
  const root = join(instanceRoot(repo, metadata.slug), "sandboxes", shortId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const contextFile = join(instanceRoot(repo, metadata.slug), "context.json");
  assertMountablePath(contextFile);
  const secrets = await resolveSecrets(repo, config, "sandbox");
  const environmentSecrets = secrets.filter((secret) => "env" in secret.target);
  const fileSecrets = secrets.filter((secret) => "file" in secret.target);
  const secretEnvFile = join(root, "secrets.env");
  if (environmentSecrets.length > 0) await writePlainSecretEnvFile(secretEnvFile, environmentSecrets);
  const secretMounts: Array<{ source: string; target: string }> = [];
  for (const [index, secret] of fileSecrets.entries()) {
    if (!("file" in secret.target)) continue;
    const source = join(root, `secret-${index}`);
    await writeFile(source, secret.value, { mode: 0o400 });
    await chmod(source, 0o400);
    assertMountablePath(source);
    assertMountablePath(secret.target.file);
    secretMounts.push({ source, target: secret.target.file });
  }

  let attachment: NetworkAttachment | undefined;
  try {
    if (posture.network === "backend") attachment = await attachBackendNetwork(metadata, shortId);
    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      `branchlift-sandbox-${shortId}`,
      "--label",
      "io.branchlift.managed=true",
      "--label",
      `io.branchlift.instance=${metadata.id}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(policy.pidsLimit),
      "--memory",
      policy.memory,
      "--cpus",
      String(policy.cpus),
      "--workdir",
      "/workspace",
      "--mount",
      `type=bind,src=${metadata.worktreePath},dst=/workspace${writableWorktree ? "" : ",readonly"}`,
      "--mount",
      `type=bind,src=${contextFile},dst=/branchlift/context.json,readonly`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=512m",
      "--tmpfs",
      "/run:rw,nosuid,nodev,size=64m",
    ];
    if (interactive) {
      args.splice(1, 0, "-i");
      if (process.stdin.isTTY && process.stdout.isTTY) args.splice(2, 0, "-t");
    }
    for (const mount of secretMounts) {
      args.push("--mount", `type=bind,src=${mount.source},dst=${mount.target},readonly`);
    }
    if (policy.readOnlyRoot) args.push("--read-only");
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      args.push("--user", `${process.getuid()}:${process.getgid()}`);
    }
    if (posture.network === "none") args.push("--network", "none");
    else if (posture.network === "outbound") {
      args.push("--network", "bridge", "--add-host", "host.docker.internal:host-gateway");
    } else if (attachment !== undefined) args.push("--network", attachment.network);
    if (environmentSecrets.length > 0) args.push("--env-file", secretEnvFile);
    for (const [key, value] of Object.entries(sandboxEnvironment(metadata, posture.network))) {
      if (value !== undefined) args.push("--env", `${key}=${value}`);
    }
    args.push(posture.image, ...command);
    const result = await runCommand("docker", args, { stdio: "inherit", allowFailure: true });
    return result.exitCode;
  } finally {
    if (attachment !== undefined) await detachBackendNetwork(attachment);
    await rm(root, { recursive: true, force: true });
  }
}

async function attachBackendNetwork(metadata: InstanceMetadata, shortId: string): Promise<NetworkAttachment> {
  if (metadata.status !== "running") {
    throw new BranchLiftError(`Backend-only sandbox networking requires a running instance; ${metadata.branch} is ${metadata.status}.`);
  }
  const network = `bl-sbx-${shortId}`;
  await runCommand("docker", [
    "network",
    "create",
    "--internal",
    "--label",
    "io.branchlift.managed=true",
    "--label",
    `io.branchlift.instance=${metadata.id}`,
    network,
  ]);
  const runtime = runtimeFromMetadata(metadata);
  const servicesResult = await runCommand("docker", [...composeArgs(runtime), "ps", "--services", "--status", "running"]);
  const containers: string[] = [];
  try {
    for (const service of servicesResult.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
      const result = await runCommand("docker", [...composeArgs(runtime), "ps", "--quiet", service]);
      for (const id of result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
        await runCommand("docker", ["network", "connect", "--alias", service, network, id]);
        containers.push(id);
      }
    }
    if (containers.length === 0) throw new BranchLiftError(`No running Compose containers were found for ${metadata.branch}.`);
    return { network, containers };
  } catch (error) {
    await detachBackendNetwork({ network, containers });
    throw error;
  }
}

async function detachBackendNetwork(attachment: NetworkAttachment): Promise<void> {
  for (const container of attachment.containers) {
    await runCommand("docker", ["network", "disconnect", "--force", attachment.network, container], { allowFailure: true });
  }
  await runCommand("docker", ["network", "rm", attachment.network], { allowFailure: true });
}

function sandboxEnvironment(
  metadata: InstanceMetadata,
  network: SandboxNetwork,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    BRANCHLIFT_INSTANCE: metadata.id,
    BRANCHLIFT_CONTEXT: "/branchlift/context.json",
    BRANCHLIFT_WORKTREE: "/workspace",
    BRANCHLIFT_SANDBOX: "1",
    COMPOSE_PROJECT_NAME: metadata.composeProject,
    HOME: "/tmp/branchlift-home",
  };
  for (const port of metadata.ports) {
    const prefix = `BRANCHLIFT_${environmentName(port.service)}_${port.target}`;
    const host = network === "backend" ? port.service : network === "outbound" ? "host.docker.internal" : "unavailable";
    const targetPort = network === "backend" ? port.target : port.port;
    env[`${prefix}_HOST`] = host;
    env[`${prefix}_PORT`] = String(targetPort);
    env[`${prefix}_URL`] = `${port.protocol}://${host}:${targetPort}`;
  }
  return env;
}

function environmentName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SERVICE";
}

function assertDockerReference(value: string): void {
  if (value.trim() === "" || value.startsWith("-") || /[\s\0]/.test(value)) {
    throw new BranchLiftError(`Unsafe sandbox image reference: ${JSON.stringify(value)}`);
  }
}

function assertMountablePath(value: string): void {
  if (value.includes(",") || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new BranchLiftError(`Path cannot be represented safely as a Docker mount: ${value}`);
  }
}
