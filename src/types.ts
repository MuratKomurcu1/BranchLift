export interface BranchLiftConfig {
  version: 1;
  compose: {
    files: string[];
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
  readOnly: boolean;
  sharedAcrossWorktrees: boolean;
}

export interface PortBinding {
  service: string;
  target: number;
  protocol: "tcp" | "udp";
}

export interface ComposeInspection {
  file: string;
  files: string[];
  services: string[];
  inferredStatefulServices: string[];
  postgresServices: string[];
  postgresDataDirectories: Record<string, string>;
  mysqlServices: string[];
  serviceCommands: Record<string, string | string[]>;
  volumes: VolumeBinding[];
  bindMounts: BindMount[];
  ports: PortBinding[];
  blockers: string[];
  warnings: string[];
  recommendations: string[];
}

export type SnapshotStatus = "building" | "ready" | "failed";

export interface SnapshotMetadata {
  version: 1;
  name: string;
  repoKey: string;
  sourceRoot: string;
  composeFile: string;
  composeFiles?: string[];
  composeProject: string;
  createdAt: string;
  completedAt?: string;
  status: SnapshotStatus;
  volumeNames: string[];
  sizeBytes?: number;
  copyStrategy?: CopyStrategy;
  importedFromProject?: string;
  postgresDataDirectories?: Record<string, string | false>;
  mysqlLowerCaseTableNames?: 0 | 1 | 2;
  error?: string;
}

export type InstanceStatus = "creating" | "running" | "stopped" | "failed";
export type WorktreeOwner = "branchlift" | "external";

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
  worktreeOwner?: WorktreeOwner;
  snapshot: string;
  composeFile: string;
  composeFiles?: string[];
  overrideFile: string;
  volumeRoot?: string;
  managedVolumes?: VolumeBinding[];
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
