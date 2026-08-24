export interface BranchLiftConfig {
  version: 1;
  compose: {
    file: string;
    statefulServices: string[];
  };
  snapshot: {
    default: string;
    healthTimeoutSeconds: number;
    seed: SeedStep[];
  };
  worktree: {
    copyFiles: string[];
  };
}

export interface SeedStep {
  service: string;
  command: string[];
}

export interface VolumeBinding {
  source: string;
  target: string;
  service: string;
  readOnly: boolean;
  external: boolean;
}

export interface BindMount {
  source: string;
  target: string;
  service: string;
}

export interface PortBinding {
  service: string;
  target: number;
  protocol: "tcp" | "udp";
}

export interface ComposeInspection {
  file: string;
  services: string[];
  inferredStatefulServices: string[];
  postgresServices: string[];
  volumes: VolumeBinding[];
  bindMounts: BindMount[];
  ports: PortBinding[];
  blockers: string[];
  warnings: string[];
}

export type SnapshotStatus = "building" | "ready" | "failed";

export interface SnapshotMetadata {
  version: 1;
  name: string;
  repoKey: string;
  sourceRoot: string;
  composeFile: string;
  composeProject: string;
  createdAt: string;
  completedAt?: string;
  status: SnapshotStatus;
  volumeNames: string[];
  sizeBytes?: number;
  copyStrategy?: CopyStrategy;
  error?: string;
}

export type InstanceStatus = "creating" | "running" | "stopped" | "failed";

export interface PublishedPort {
  service: string;
  target: number;
  protocol: "tcp" | "udp";
  host: string;
  port: number;
}

export interface InstanceMetadata {
  version: 1;
  id: string;
  branch: string;
  slug: string;
  repoKey: string;
  sourceRoot: string;
  worktreePath: string;
  snapshot: string;
  composeFile: string;
  overrideFile: string;
  composeProject: string;
  createdAt: string;
  updatedAt: string;
  status: InstanceStatus;
  ports: PublishedPort[];
  copyStrategy: CopyStrategy;
  error?: string;
}

export type CopyStrategy = "apfs-clone" | "linux-reflink" | "recursive-copy" | "empty";

export interface RepoInfo {
  root: string;
  commonDir: string;
  name: string;
  key: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
