import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { volumeDirectoryName } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import { runCommand } from "./process.js";
import type { ComposeInspection, PublishedPort, VolumeBinding } from "./types.js";

export interface ComposeRuntime {
  cwd: string;
  composeFiles: string[];
  overrideFile: string;
  project: string;
}

export interface SourceComposeRuntime {
  cwd: string;
  composeFiles: string[];
  project?: string;
}

export interface ComposeServiceStatus {
  service: string;
  state: string;
  health?: string;
}

export async function assertDockerReady(): Promise<void> {
  const result = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new BranchLiftError("Docker is not ready.", "Start Docker or a compatible Docker daemon and retry.");
  }
  const compose = await runCommand("docker", ["compose", "version"], { allowFailure: true });
  if (compose.exitCode !== 0) throw new BranchLiftError("Docker Compose v2 is required.");
  const version = parseComposeVersion(compose.stdout || compose.stderr);
  if (version !== undefined && compareVersion(version, [2, 24, 4]) < 0) {
    throw new BranchLiftError(
      `Docker Compose 2.24.4 or newer is required; found ${version.join(".")}.`,
      "Upgrade Docker Desktop or the Docker Compose plugin. BranchLift uses the Compose !override merge tag for collision-free ports.",
    );
  }
}

export function parseComposeVersion(value: string): [number, number, number] | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function validateCompose(runtime: ComposeRuntime): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "config", "--quiet"], { cwd: runtime.cwd });
}

export async function composeUp(
  runtime: ComposeRuntime,
  timeoutSeconds: number,
  quiet = false,
  managedVolumes: VolumeBinding[] = [],
  volumeRoot?: string,
): Promise<void> {
  try {
    if (volumeRoot !== undefined && managedVolumes.length > 0) {
      await prepareRuntimeStateOwnership(runtime, managedVolumes, volumeRoot, quiet);
    }
    await runCommand(
      "docker",
      [...composeArgs(runtime), "up", "-d", "--wait", "--wait-timeout", String(timeoutSeconds)],
      { cwd: runtime.cwd, stdio: quiet ? "capture" : "inherit" },
    );
  } catch (error) {
    const logs = await runCommand("docker", [...composeArgs(runtime), "logs", "--no-color", "--tail", "80"], {
      cwd: runtime.cwd,
      allowFailure: true,
    });
    const detail = [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join("\n");
    await normalizeRuntimeStateOwnership(runtime, managedVolumes, volumeRoot);
    await composeDownBestEffort(runtime);
    throw new BranchLiftError(
      "Compose stack failed to become healthy.",
      detail !== "" ? detail : error instanceof Error ? error.message : String(error),
    );
  }
}

async function prepareRuntimeStateOwnership(
  runtime: ComposeRuntime,
  volumes: VolumeBinding[],
  volumeRoot: string,
  quiet: boolean,
): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "create"], {
    cwd: runtime.cwd,
    stdio: quiet ? "capture" : "inherit",
  });
  const unique = new Map(volumes.map((volume) => [`${volume.service}\0${volume.target}`, volume]));
  const helperImages = await runtimeStateHelperImages(runtime, [...unique.values()].map(({ service }) => service));
  for (const volume of unique.values()) {
    if (volume.readOnly) continue;
    const owner = await runtimeServiceOwner(runtime, volume.service);
    if (owner === undefined || owner === "0" || owner.startsWith("0:")) continue;
    await chownRuntimeDirectory(runtime, helperImages, join(volumeRoot, volumeDirectoryName(volume.source)), owner);
  }
}

export async function normalizeRuntimeStateOwnership(
  runtime: ComposeRuntime,
  volumes: VolumeBinding[],
  volumeRoot?: string,
): Promise<void> {
  if (process.getuid === undefined || process.getgid === undefined || process.getuid() === 0) return;
  const owner = `${process.getuid()}:${process.getgid()}`;
  const unique = new Map(volumes.map((volume) => [`${volume.service}\0${volume.target}`, volume]));
  const helperImages = volumeRoot === undefined
    ? []
    : await runtimeStateHelperImages(runtime, [...unique.values()].map(({ service }) => service));
  for (const volume of unique.values()) {
    if (volume.readOnly) continue;
    await runCommand(
      "docker",
      [...composeArgs(runtime), "exec", "-T", "--user", "0", volume.service, "chown", "-R", owner, volume.target],
      { cwd: runtime.cwd, allowFailure: true },
    );
  }
  await runCommand("docker", [...composeArgs(runtime), "stop"], { cwd: runtime.cwd, allowFailure: true });
  if (volumeRoot === undefined) return;
  for (const volume of unique.values()) {
    if (volume.readOnly) continue;
    const source = join(volumeRoot, volumeDirectoryName(volume.source));
    await chownRuntimeDirectory(runtime, helperImages, source, owner);
  }
}

async function runtimeServiceOwner(runtime: ComposeRuntime, service: string): Promise<string | undefined> {
  const containers = await runCommand("docker", [...composeArgs(runtime), "ps", "--all", "--quiet", service], {
    cwd: runtime.cwd,
    allowFailure: true,
  });
  const container = containers.stdout.split("\n").map((value) => value.trim()).find(Boolean);
  if (container === undefined) return undefined;
  const inspected = await runCommand("docker", ["inspect", "--format", "{{.Config.User}}", container], {
    cwd: runtime.cwd,
    allowFailure: true,
  });
  const owner = inspected.stdout.trim();
  return inspected.exitCode === 0 && /^\d+(?::\d+)?$/.test(owner) ? owner : undefined;
}

async function chownRuntimeDirectory(
  runtime: ComposeRuntime,
  helperImages: string[],
  source: string,
  owner: string,
): Promise<boolean> {
  for (const image of helperImages) {
    const result = await runCommand(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0",
        "--entrypoint",
        "chown",
        "--mount",
        `type=bind,src=${source},dst=/branchlift-state`,
        image,
        "-R",
        owner,
        "/branchlift-state",
      ],
      { cwd: runtime.cwd, allowFailure: true },
    );
    if (result.exitCode === 0) return true;
  }
  return false;
}

async function runtimeStateHelperImages(runtime: ComposeRuntime, services: string[]): Promise<string[]> {
  const images = new Set<string>();
  for (const service of new Set(services)) {
    const containers = await runCommand(
      "docker",
      [...composeArgs(runtime), "ps", "--all", "--quiet", service],
      { cwd: runtime.cwd, allowFailure: true },
    );
    for (const container of containers.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
      const inspected = await runCommand("docker", ["inspect", "--format", "{{.Image}}", container], {
        cwd: runtime.cwd,
        allowFailure: true,
      });
      const image = inspected.stdout.trim();
      if (inspected.exitCode === 0 && image !== "") images.add(image);
    }
  }
  return [...images];
}

export async function composeLogs(
  runtime: ComposeRuntime,
  options: { service?: string; tail: number; follow: boolean; timestamps: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = [...composeArgs(runtime), "logs", "--no-color", "--tail", String(options.tail)];
  if (options.timestamps) args.push("--timestamps");
  if (options.follow) args.push("--follow");
  if (options.service !== undefined) args.push(options.service);
  return await runCommand("docker", args, {
    cwd: runtime.cwd,
    stdio: options.follow ? "inherit" : "capture",
    allowFailure: false,
  });
}

export async function composeServiceStatuses(runtime: ComposeRuntime): Promise<ComposeServiceStatus[] | undefined> {
  try {
    const result = await runCommand(
      "docker",
      [...composeArgs(runtime), "ps", "--all", "--format", "json"],
      { cwd: runtime.cwd, allowFailure: true },
    );
    if (result.exitCode !== 0) return undefined;
    const records = parseJsonRecords(result.stdout);
    return records.flatMap((record) => {
      const service = stringField(record, "Service");
      const state = stringField(record, "State");
      if (service === undefined || state === undefined) return [];
      const health = stringField(record, "Health");
      return [{ service, state, ...(health === undefined || health === "" ? {} : { health }) }];
    });
  } catch {
    return undefined;
  }
}

export async function composeDown(runtime: ComposeRuntime): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "down", "--remove-orphans"], {
    cwd: runtime.cwd,
    stdio: "inherit",
  });
}

export async function composeStop(runtime: ComposeRuntime): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "stop"], {
    cwd: runtime.cwd,
    stdio: "inherit",
  });
}

export async function sourceRunningServices(runtime: SourceComposeRuntime): Promise<string[]> {
  const result = await runCommand(
    "docker",
    [...sourceComposeArgs(runtime), "ps", "--status", "running", "--services"],
    { cwd: runtime.cwd },
  );
  return [...new Set(result.stdout.split("\n").map((service) => service.trim()).filter(Boolean))].sort();
}

export async function stopSourceServices(runtime: SourceComposeRuntime, services: string[]): Promise<void> {
  if (services.length === 0) return;
  await runCommand("docker", [...sourceComposeArgs(runtime), "stop", ...services], {
    cwd: runtime.cwd,
  });
}

export async function startSourceServices(runtime: SourceComposeRuntime, services: string[]): Promise<void> {
  if (services.length === 0) return;
  await runCommand("docker", [...sourceComposeArgs(runtime), "start", ...services], {
    cwd: runtime.cwd,
  });
}

export async function copySourceServicePathToHost(
  runtime: SourceComposeRuntime,
  service: string,
  sourcePath: string,
  destination: string,
): Promise<void> {
  const container = await runCommand(
    "docker",
    [...sourceComposeArgs(runtime), "ps", "--all", "--quiet", service],
    { cwd: runtime.cwd },
  );
  const id = container.stdout.trim().split("\n").find(Boolean);
  if (id === undefined) {
    throw new BranchLiftError(
      `Cannot import ${service}:${sourcePath}; the source Compose service has no container.`,
      "Run the source stack at least once with docker compose up -d, then retry the import.",
    );
  }
  await extractContainerPath(id, sourcePath, destination, runtime.cwd);
}

export async function copyServicePathToHost(
  runtime: ComposeRuntime,
  service: string,
  sourcePath: string,
  destination: string,
): Promise<void> {
  const container = await runCommand("docker", [...composeArgs(runtime), "ps", "--all", "--quiet", service], {
    cwd: runtime.cwd,
  });
  const id = container.stdout.trim().split("\n").find(Boolean);
  if (id === undefined) throw new BranchLiftError(`Cannot find the stopped ${service} container for snapshot export.`);
  await extractContainerPath(id, sourcePath, destination, runtime.cwd);
}

export async function removeDockerVolumes(names: Iterable<string>, allowFailure = false): Promise<void> {
  for (const name of names) {
    await runCommand("docker", ["volume", "rm", name], { allowFailure });
  }
}

export async function composeDownBestEffort(runtime: ComposeRuntime): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "down", "--remove-orphans"], {
    cwd: runtime.cwd,
    allowFailure: true,
  });
}

export async function composeSeed(
  runtime: ComposeRuntime,
  service: string,
  command: string[],
): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "exec", "-T", service, ...command], {
    cwd: runtime.cwd,
    stdio: "inherit",
  });
}

export async function publishedPorts(
  runtime: ComposeRuntime,
  inspection: ComposeInspection,
): Promise<PublishedPort[]> {
  const groups = await Promise.all(inspection.ports.map(async (binding) => {
    const target = binding.protocol === "udp" ? `${binding.target}/udp` : String(binding.target);
    const result = await runCommand("docker", [...composeArgs(runtime), "port", binding.service, target], {
      cwd: runtime.cwd,
      allowFailure: true,
    });
    if (result.exitCode !== 0) return [];
    const found: PublishedPort[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (line.trim() === "") continue;
      const parsed = parseAddress(line.trim());
      if (parsed === undefined) continue;
      found.push({ ...binding, host: parsed.host, port: parsed.port });
    }
    return found;
  }));
  const unique = new Map<string, PublishedPort>();
  for (const port of groups.flat()) {
    unique.set(`${port.service}\0${port.target}\0${port.protocol}\0${port.host}\0${port.port}`, port);
  }
  return [...unique.values()];
}

export function composeArgs(runtime: ComposeRuntime): string[] {
  const args = ["compose"];
  for (const file of runtime.composeFiles) args.push("-f", file);
  args.push("-f", runtime.overrideFile, "-p", runtime.project);
  return args;
}

export function sourceComposeArgs(runtime: SourceComposeRuntime): string[] {
  const args = ["compose"];
  for (const file of runtime.composeFiles) args.push("-f", file);
  if (runtime.project !== undefined) args.push("-p", runtime.project);
  return args;
}

async function extractContainerPath(
  container: string,
  sourcePath: string,
  destination: string,
  cwd: string,
): Promise<void> {
  const source = `${container}:${sourcePath.replace(/\/$/, "")}/.`;
  const docker = spawn("docker", ["cp", source, "-"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const tar = spawn("tar", ["-x", "--no-same-owner", "-f", "-", "-C", destination], {
    cwd,
    stdio: ["pipe", "ignore", "pipe"],
    shell: false,
  });
  if (docker.stdout === null || tar.stdin === null) {
    docker.kill();
    tar.kill();
    throw new BranchLiftError(`Unable to create the snapshot export pipeline for ${sourcePath}.`);
  }
  docker.stdout.pipe(tar.stdin);
  // If tar exits first, the pipe can report EPIPE while both process exit codes
  // still contain the useful diagnostic.
  tar.stdin.on("error", () => undefined);
  try {
    const [dockerResult, tarResult] = await Promise.all([childResult(docker), childResult(tar)]);
    if (dockerResult.exitCode !== 0 || tarResult.exitCode !== 0) {
      const detail = [dockerResult.stderr, tarResult.stderr].map((value) => value.trim()).filter(Boolean).join("\n");
      throw new BranchLiftError(
        `Unable to export ${sourcePath} from the stopped container.`,
        detail === "" ? `docker cp exited ${dockerResult.exitCode}; tar exited ${tarResult.exitCode}` : detail,
      );
    }
  } catch (error) {
    docker.kill();
    tar.kill();
    throw error;
  }
}

async function childResult(child: ChildProcess): Promise<{ exitCode: number; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stderr }));
  });
}

function parseAddress(value: string): { host: string; port: number } | undefined {
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(value);
  if (ipv6) return { host: ipv6[1] ?? "::", port: Number(ipv6[2]) };
  const regular = /^(.*):(\d+)$/.exec(value);
  if (!regular) return undefined;
  return { host: regular[1] || "127.0.0.1", port: Number(regular[2]) };
}

function parseJsonRecords(value: string): Record<string, unknown>[] {
  const trimmed = value.trim();
  if (trimmed === "") return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) return [parsed];
  } catch {
    const records: Record<string, unknown>[] = [];
    for (const line of trimmed.split("\n")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        return [];
      }
    }
    return records;
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}
