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
  security?: SecurityConfig;
  secrets?: Record<string, SecretDefinition>;
  ui?: UiConfig;
}

export type SandboxBackend = "docker" | "host";
export type SandboxNetwork = "none" | "backend" | "outbound";

export interface SecurityConfig {
  sandbox: {
    backend: SandboxBackend;
    image: string;
    network: SandboxNetwork;
    readOnlyRoot: boolean;
    memory: string;
    cpus: number;
    pidsLimit: number;
  };
  allowHostAgentCommands: boolean;
  allowSecretCommands: boolean;
}

export type SecretScope = "compose" | "exec" | "agent" | "sandbox";

export interface SecretDefinition {
  source:
    | { env: string }
    | { file: string }
    | { command: string[] };
  target:
    | { env: string }
    | { file: string };
  scopes: SecretScope[];
  required: boolean;
}

export interface UiConfig {
  host: "127.0.0.1" | "::1";
  port: number;
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
  hostIp?: string;
}

export interface ComposeInspection {
  file: string;
  files: string[];
  services: string[];
  inferredStatefulServices: string[];
  postgresServices: string[];
  postgresDataDirectories: Record<string, string>;
  mysqlServices: string[];
  mongodbServices: string[];
  kafkaServices: string[];
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
  parentSnapshot?: string;
  sourceInstance?: string;
  contentDigest?: string;
  manifestFile?: string;
  fileCount?: number;
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
  /** Managed source volume -> container-runtime volume name for filesystems that cannot run safely as host binds. */
  nativeVolumes?: Record<string, string>;
  composeProject: string;
  createdAt: string;
  updatedAt: string;
  status: InstanceStatus;
  ports: PublishedPort[];
  copyStrategy: CopyStrategy;
  secretEnvFile?: string;
  error?: string;
}

export interface SnapshotManifestEntry {
  volume: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  digest: string;
}

export interface SnapshotManifest {
  version: 1;
  snapshot: string;
  createdAt: string;
  digest: string;
  logicalBytes: number;
  entries: SnapshotManifestEntry[];
}

export type AuditEventLevel = "info" | "warning" | "error";

export interface AuditEvent {
  version: 1;
  id: string;
  timestamp: string;
  repoKey: string;
  kind: string;
  level: AuditEventLevel;
  message: string;
  branch?: string;
  snapshot?: string;
  details?: Record<string, unknown>;
}

export interface RemoteDefinition {
  version: 1;
  name: string;
  host: string;
  user?: string;
  port: number;
  identityFile?: string;
  repoPath: string;
  binary: string;
  managedBinary?: boolean;
  lastSetupAt?: string;
  createdAt: string;
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

export type WorkspaceTaskStatus = "backlog" | "ready" | "running" | "review" | "done";

export interface WorkspaceTask {
  version: 1;
  id: string;
  title: string;
  prompt: string;
  branch?: string;
  agent?: string;
  status: WorkspaceTaskStatus;
  createdAt: string;
  updatedAt: string;
}

export type TeamRole = "viewer" | "operator" | "admin";

export interface TeamTokenDefinition {
  version: 1;
  id: string;
  label: string;
  role: TeamRole;
  digest: string;
  createdAt: string;
}

export interface TeamRegistryNode {
  version: 1;
  repository: { key: string; name: string };
  node: { id: string; hostname: string };
  updatedAt: string;
  environments: Array<{ branch: string; snapshot: string; status: InstanceStatus; ports: PublishedPort[] }>;
  snapshots: Array<{ name: string; parentSnapshot?: string; createdAt: string; sizeBytes?: number }>;
  tasks: Array<{ id: string; title: string; status: WorkspaceTaskStatus; branch?: string; agent?: string; updatedAt: string }>;
}
