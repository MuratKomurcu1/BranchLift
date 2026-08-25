import { composeLogs, composeServiceStatuses } from "./docker.js";
import { BranchLiftError } from "./errors.js";
import { runtimeFromMetadata } from "./runtime.js";
import { listInstances } from "./state.js";
import type { InstanceMetadata, RepoInfo } from "./types.js";

export interface PreviewEndpoint {
  service: string;
  target: number;
  protocol: "tcp" | "udp";
  url: string;
}

export interface InstancePreview {
  branch: string;
  status: InstanceMetadata["status"];
  snapshot: string;
  worktreePath: string;
  composeProject: string;
  endpoints: PreviewEndpoint[];
  services?: Array<{ service: string; state: string; health?: string }>;
}

export interface LogOptions {
  service?: string;
  tail: number;
  follow: boolean;
  timestamps: boolean;
}

export async function previewInstances(repo: RepoInfo, branch?: string): Promise<InstancePreview[]> {
  const all = await listInstances(repo);
  const selected = branch === undefined ? all : all.filter((instance) => instance.branch === branch);
  if (branch !== undefined && selected.length === 0) throw new BranchLiftError(`Instance not found: ${branch}`);
  return await Promise.all(selected.map(previewInstance));
}

export async function readInstanceLogs(repo: RepoInfo, branch: string, options: LogOptions): Promise<string> {
  const instance = (await listInstances(repo)).find((candidate) => candidate.branch === branch);
  if (instance === undefined) throw new BranchLiftError(`Instance not found: ${branch}`);
  const result = await composeLogs(runtimeFromMetadata(instance), options);
  return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
}

async function previewInstance(instance: InstanceMetadata): Promise<InstancePreview> {
  const services = await composeServiceStatuses(runtimeFromMetadata(instance));
  return {
    branch: instance.branch,
    status: instance.status,
    snapshot: instance.snapshot,
    worktreePath: instance.worktreePath,
    composeProject: instance.composeProject,
    endpoints: instance.ports.map((port) => ({
      service: port.service,
      target: port.target,
      protocol: port.protocol,
      url: `${port.protocol}://${normalizeHost(port.host)}:${port.port}`,
    })),
    ...(services === undefined ? {} : { services }),
  };
}

function normalizeHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}
