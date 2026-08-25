import { readFile } from "node:fs/promises";
import { BranchLiftError } from "./errors.js";

export type ContainerCli = "docker" | "podman";

export interface HostPlatformSupport {
  platform: NodeJS.Platform;
  environment: "native" | "wsl2";
  supported: boolean;
  containerCli: ContainerCli;
  guidance: string;
}

export function containerCli(environment: NodeJS.ProcessEnv = process.env): ContainerCli {
  const value = (environment.BRANCHLIFT_CONTAINER_CLI ?? "docker").trim().toLowerCase();
  if (value !== "docker" && value !== "podman") {
    throw new BranchLiftError("BRANCHLIFT_CONTAINER_CLI must be docker or podman.");
  }
  return value;
}

export async function inspectHostPlatform(): Promise<HostPlatformSupport> {
  const release = process.platform === "linux"
    ? await readFile("/proc/sys/kernel/osrelease", "utf8").catch(() => "")
    : "";
  return classifyHostPlatform(process.platform, release, containerCli());
}

export function classifyHostPlatform(
  platform: NodeJS.Platform,
  kernelRelease: string,
  cli: ContainerCli,
): HostPlatformSupport {
  const wsl2 = platform === "linux" && /microsoft.*wsl2|wsl2.*microsoft/i.test(kernelRelease);
  if (platform === "win32") {
    return {
      platform,
      environment: "native",
      supported: false,
      containerCli: cli,
      guidance: "Use BranchLift inside WSL2; native Windows paths and ownership semantics are not supported.",
    };
  }
  return {
    platform,
    environment: wsl2 ? "wsl2" : "native",
    supported: platform === "linux" || platform === "darwin",
    containerCli: cli,
    guidance: wsl2
      ? "WSL2 detected. Keep the repository in the Linux filesystem for reliable worktrees and volume ownership."
      : platform === "darwin" || platform === "linux"
        ? `${cli === "podman" ? "Podman" : "Docker"} lifecycle support selected.`
        : "BranchLift currently supports macOS, Linux, and Windows through WSL2.",
  };
}
