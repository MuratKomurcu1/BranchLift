import { BranchLiftError } from "./errors.js";
import { runCommand } from "./process.js";
import type { ComposeInspection, PublishedPort } from "./types.js";

export interface ComposeRuntime {
  cwd: string;
  composeFile: string;
  overrideFile: string;
  project: string;
}

export async function assertDockerReady(): Promise<void> {
  const result = await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new BranchLiftError("Docker is not ready.", "Start Docker or a compatible Docker daemon and retry.");
  }
  const compose = await runCommand("docker", ["compose", "version"], { allowFailure: true });
  if (compose.exitCode !== 0) throw new BranchLiftError("Docker Compose v2 is required.");
}

export async function validateCompose(runtime: ComposeRuntime): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "config", "--quiet"], { cwd: runtime.cwd });
}

export async function composeUp(runtime: ComposeRuntime, timeoutSeconds: number): Promise<void> {
  try {
    await runCommand(
      "docker",
      [...composeArgs(runtime), "up", "-d", "--wait", "--wait-timeout", String(timeoutSeconds)],
      { cwd: runtime.cwd, stdio: "inherit" },
    );
  } catch (error) {
    const logs = await runCommand("docker", [...composeArgs(runtime), "logs", "--no-color", "--tail", "80"], {
      cwd: runtime.cwd,
      allowFailure: true,
    });
    const detail = [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join("\n");
    await composeDownBestEffort(runtime);
    throw new BranchLiftError(
      "Compose stack failed to become healthy.",
      detail !== "" ? detail : error instanceof Error ? error.message : String(error),
    );
  }
}

export async function composeDown(runtime: ComposeRuntime): Promise<void> {
  await runCommand("docker", [...composeArgs(runtime), "down", "--remove-orphans"], {
    cwd: runtime.cwd,
    stdio: "inherit",
  });
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
  const found: PublishedPort[] = [];
  for (const binding of inspection.ports) {
    const target = binding.protocol === "udp" ? `${binding.target}/udp` : String(binding.target);
    const result = await runCommand("docker", [...composeArgs(runtime), "port", binding.service, target], {
      cwd: runtime.cwd,
      allowFailure: true,
    });
    if (result.exitCode !== 0) continue;
    for (const line of result.stdout.trim().split("\n")) {
      if (line.trim() === "") continue;
      const parsed = parseAddress(line.trim());
      if (parsed === undefined) continue;
      if (!found.some((item) => item.service === binding.service && item.target === binding.target && item.port === parsed.port)) {
        found.push({ ...binding, host: parsed.host, port: parsed.port });
      }
    }
  }
  return found;
}

export function composeArgs(runtime: ComposeRuntime): string[] {
  return [
    "compose",
    "-f",
    runtime.composeFile,
    "-f",
    runtime.overrideFile,
    "-p",
    runtime.project,
  ];
}

function parseAddress(value: string): { host: string; port: number } | undefined {
  const ipv6 = /^\[([^\]]+)]:(\d+)$/.exec(value);
  if (ipv6) return { host: ipv6[1] ?? "::", port: Number(ipv6[2]) };
  const regular = /^(.*):(\d+)$/.exec(value);
  if (!regular) return undefined;
  return { host: regular[1] || "127.0.0.1", port: Number(regular[2]) };
}
