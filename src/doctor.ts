import { randomUUID } from "node:crypto";
import { readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { volumeDirectoryName } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import {
  instanceLockScope,
  listLocks,
  removeStaleLock,
  snapshotLockScope,
  withLock,
} from "./lock.js";
import { runCommand } from "./process.js";
import { pathExists, readJson, repoDataRoot, safeSlug, snapshotRoot, writeJsonAtomic } from "./paths.js";
import {
  isInstanceMetadata,
  isSnapshotMetadata,
  listInstances,
  listSnapshots,
  readInstanceMetadata,
  writeInstanceMetadata,
} from "./state.js";
import type { InstanceMetadata, RepoInfo, SnapshotMetadata } from "./types.js";

export type DoctorSeverity = "warning" | "error";

export interface DockerProjectState {
  containers: number;
  running: number;
}

export interface DoctorFinding {
  code:
    | "snapshot-not-ready"
    | "snapshot-volume-missing"
    | "snapshot-diagnostic-state"
    | "abandoned-snapshot-build"
    | "instance-snapshot-missing"
    | "instance-worktree-missing"
    | "instance-override-missing"
    | "instance-compose-missing"
    | "state-metadata-invalid"
    | "abandoned-instance-creation"
    | "stale-lock"
    | "stale-running-status"
    | "lingering-runtime"
    | "orphan-runtime";
  severity: DoctorSeverity;
  message: string;
  fixable: boolean;
  target?: string;
  snapshotName?: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  instances: number;
  snapshots: number;
  dockerProjects: number;
  activeLocks: number;
  staleLocks: number;
  dockerAudited: boolean;
}

export async function inspectDockerProjects(): Promise<Map<string, DockerProjectState>> {
  const result = await runCommand(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.State}}',
    ],
  );
  const projects = new Map<string, DockerProjectState>();
  for (const line of result.stdout.split("\n")) {
    const [project, state] = line.trim().split("\t");
    if (!project) continue;
    const current = projects.get(project) ?? { containers: 0, running: 0 };
    current.containers += 1;
    if (state === "running") current.running += 1;
    projects.set(project, current);
  }
  for (const group of ["network", "volume"] as const) {
    const resources = await runCommand("docker", [
      group,
      "ls",
      "--filter",
      "label=com.docker.compose.project",
      "--format",
      '{{.Label "com.docker.compose.project"}}',
    ]);
    for (const project of resources.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
      if (!projects.has(project)) projects.set(project, { containers: 0, running: 0 });
    }
  }
  return projects;
}

export async function auditState(
  repo: RepoInfo,
  dockerProjects?: ReadonlyMap<string, DockerProjectState>,
): Promise<DoctorReport> {
  const [instances, snapshots, locks] = await Promise.all([listInstances(repo), listSnapshots(repo), listLocks(repo)]);
  const findings: DoctorFinding[] = [];
  const snapshotNames = new Set(snapshots.map(({ name }) => name));
  const knownProjects = new Set<string>();
  const activeLockScopes = new Set(
    locks
      .filter(({ status, metadata }) => status === "active" && metadata !== undefined)
      .map(({ metadata }) => metadata!.scope),
  );

  for (const lock of locks) {
    if (lock.status !== "stale") continue;
    findings.push({
      code: "stale-lock",
      severity: "warning",
      message: `Stale operation lock ${lock.metadata?.scope ?? lock.path}: ${lock.reason}`,
      fixable: true,
      target: lock.path,
    });
  }

  for (const snapshot of snapshots) {
    knownProjects.add(snapshot.composeProject);
    if (snapshot.status !== "ready") {
      findings.push({
        code: "snapshot-not-ready",
        severity: "error",
        message: `Snapshot ${snapshot.name} is ${snapshot.status}.`,
        fixable: false,
        target: snapshot.name,
      });
    }
    for (const volume of snapshot.volumeNames) {
      if (!(await pathExists(join(snapshotRoot(repo, snapshot.name), "volumes", volumeDirectoryName(volume))))) {
        findings.push({
          code: "snapshot-volume-missing",
          severity: "error",
          message: `Snapshot ${snapshot.name} is missing volume state for ${volume}.`,
          fixable: false,
          target: snapshot.name,
        });
      }
    }
    if (dockerProjects?.has(snapshot.composeProject)) {
      findings.push({
        code: "lingering-runtime",
        severity: "warning",
        message: `Snapshot build runtime ${snapshot.composeProject} is still present.`,
        fixable: true,
        target: snapshot.composeProject,
      });
    }
  }

  for (const project of await auditDiagnosticSnapshotDirectories(
    repo,
    findings,
    activeLockScopes,
    dockerProjects,
  )) knownProjects.add(project);
  await auditInvalidMetadata(repo, findings);

  for (const instance of instances) {
    knownProjects.add(instance.composeProject);
    if (instance.status === "creating" && !activeLockScopes.has(instanceLockScope(instance.branch))) {
      findings.push({
        code: "abandoned-instance-creation",
        severity: "warning",
        message: `Instance ${instance.branch} was left in creating state without a live owner.`,
        fixable: true,
        target: instance.slug,
      });
    }
    if (!snapshotNames.has(instance.snapshot)) {
      findings.push({
        code: "instance-snapshot-missing",
        severity: "error",
        message: `Instance ${instance.branch} references missing snapshot ${instance.snapshot}.`,
        fixable: false,
        target: instance.slug,
      });
    }
    await auditInstanceFiles(instance, findings);
    const project = dockerProjects?.get(instance.composeProject);
    if (dockerProjects !== undefined && instance.status === "running" && (project === undefined || project.running === 0)) {
      findings.push({
        code: "stale-running-status",
        severity: "warning",
        message: `Instance ${instance.branch} says running but has no running containers.`,
        fixable: true,
        target: instance.slug,
      });
    } else if (dockerProjects !== undefined && instance.status !== "running" && project !== undefined) {
      findings.push({
        code: "lingering-runtime",
        severity: "warning",
        message: `Stopped instance ${instance.branch} still has Docker resources (${instance.composeProject}).`,
        fixable: true,
        target: instance.composeProject,
      });
    }
  }

  const prefix = projectPrefix(repo);
  if (dockerProjects !== undefined) {
    for (const project of dockerProjects.keys()) {
      if (!project.startsWith(prefix) || knownProjects.has(project)) continue;
      findings.push({
        code: "orphan-runtime",
        severity: "warning",
        message: `Docker project ${project} has no BranchLift metadata.`,
        fixable: true,
        target: project,
      });
    }
  }

  return {
    findings,
    instances: instances.length,
    snapshots: snapshots.length,
    dockerProjects: dockerProjects?.size ?? 0,
    activeLocks: locks.filter(({ status }) => status === "active").length,
    staleLocks: locks.filter(({ status }) => status === "stale").length,
    dockerAudited: dockerProjects !== undefined,
  };
}

export async function applyDoctorFixes(repo: RepoInfo, report: DoctorReport): Promise<string[]> {
  const fixed: string[] = [];
  for (const finding of report.findings) {
    if (!finding.fixable || finding.target === undefined) continue;
    if (finding.code === "stale-lock") {
      if (await removeStaleLock(repo, finding.target)) fixed.push(`Removed stale operation lock ${finding.target}.`);
      continue;
    }
    if (finding.code === "abandoned-snapshot-build") {
      if (!report.dockerAudited) continue;
      const recovered = await recoverAbandonedSnapshot(repo, finding);
      if (recovered !== undefined) fixed.push(`Recovered abandoned snapshot build at ${recovered}.`);
      continue;
    }
    if (finding.code === "abandoned-instance-creation") {
      const metadata = await readInstanceMetadata(repo, finding.target);
      await withLock(repo, instanceLockScope(metadata.branch), "doctor recovery", async () => {
        const current = await readInstanceMetadata(repo, finding.target!);
        if (current.status !== "creating") return;
        current.status = "failed";
        current.ports = [];
        current.error = "Recovered by doctor after the creating operation lost its owner.";
        current.updatedAt = new Date().toISOString();
        await writeInstanceMetadata(repo, current.slug, current);
        fixed.push(`Marked abandoned instance ${current.branch} as failed.`);
      });
      continue;
    }
    if (finding.code === "stale-running-status") {
      const metadata = await readInstanceMetadata(repo, finding.target);
      if (metadata.status !== "running") continue;
      const liveProject = (await inspectDockerProjects()).get(metadata.composeProject);
      if (liveProject !== undefined && liveProject.running > 0) continue;
      metadata.status = "stopped";
      metadata.ports = [];
      delete metadata.error;
      metadata.updatedAt = new Date().toISOString();
      await writeInstanceMetadata(repo, metadata.slug, metadata);
      fixed.push(`Reconciled ${metadata.branch} to stopped.`);
      continue;
    }
    if (finding.code === "orphan-runtime" || finding.code === "lingering-runtime") {
      if (!finding.target.startsWith(projectPrefix(repo))) continue;
      const instances = await listInstances(repo);
      const owner = instances.find(({ composeProject }) => composeProject === finding.target);
      if (owner?.status === "running") continue;
      if (finding.code === "orphan-runtime" && (await knownProjectNames(repo)).has(finding.target)) continue;
      await removeDockerProject(finding.target);
      fixed.push(`Removed Docker resources for ${finding.target}.`);
    }
  }
  return fixed;
}

async function auditInstanceFiles(instance: InstanceMetadata, findings: DoctorFinding[]): Promise<void> {
  const checks: Array<{
    path: string;
    code: "instance-worktree-missing" | "instance-override-missing" | "instance-compose-missing";
    label: string;
  }> = [
    { path: instance.worktreePath, code: "instance-worktree-missing", label: "worktree" },
    { path: instance.overrideFile, code: "instance-override-missing", label: "generated Compose override" },
    ...(instance.composeFiles ?? [instance.composeFile]).map((file) => ({
      path: resolve(instance.worktreePath, file),
      code: "instance-compose-missing" as const,
      label: `Compose file ${file}`,
    })),
  ];
  for (const check of checks) {
    if (await pathExists(check.path)) continue;
    findings.push({
      code: check.code,
      severity: "error",
      message: `Instance ${instance.branch} is missing its ${check.label}: ${check.path}`,
      fixable: false,
      target: instance.slug,
    });
  }
}

async function auditDiagnosticSnapshotDirectories(
  repo: RepoInfo,
  findings: DoctorFinding[],
  activeLockScopes: ReadonlySet<string>,
  dockerProjects?: ReadonlyMap<string, DockerProjectState>,
): Promise<Set<string>> {
  const root = join(repoDataRoot(repo), "snapshots");
  const projects = new Set<string>();
  if (!(await pathExists(root))) return projects;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || (!entry.name.startsWith(".failed-") && !entry.name.startsWith(".building-"))) continue;
    const metadataPath = join(root, entry.name, "metadata.json");
    let metadata: SnapshotMetadata | undefined;
    if (await pathExists(metadataPath)) {
      try {
        const value = await readJson<unknown>(metadataPath);
        if (isSnapshotMetadata(value)) {
          metadata = value;
          projects.add(value.composeProject);
        }
      } catch {
        // Invalid metadata is reported separately.
      }
    }
    const path = join(root, entry.name);
    if (
      entry.name.startsWith(".building-")
      && metadata?.status === "building"
      && !activeLockScopes.has(snapshotLockScope(metadata.name))
    ) {
      findings.push({
        code: "abandoned-snapshot-build",
        severity: "warning",
        message: `Snapshot ${metadata.name} was left building without a live owner at ${path}.`,
        fixable: dockerProjects !== undefined,
        target: path,
        snapshotName: metadata.name,
      });
      continue;
    }
    if (entry.name.startsWith(".building-") && metadata?.status === "building") continue;
    findings.push({
      code: "snapshot-diagnostic-state",
      severity: "warning",
      message: `Diagnostic snapshot state is preserved at ${path}.`,
      fixable: false,
      target: entry.name,
    });
  }
  return projects;
}

async function recoverAbandonedSnapshot(repo: RepoInfo, finding: DoctorFinding): Promise<string | undefined> {
  if (finding.target === undefined || finding.snapshotName === undefined) return undefined;
  const parent = resolve(repoDataRoot(repo), "snapshots");
  const target = resolve(finding.target);
  if (!target.startsWith(`${parent}/`)) {
    throw new BranchLiftError(`Refusing to recover snapshot state outside BranchLift: ${target}`);
  }

  return await withLock(repo, snapshotLockScope(finding.snapshotName), "doctor recovery", async () => {
    if (!(await pathExists(target))) return undefined;
    const metadataPath = join(target, "metadata.json");
    const value = await readJson<unknown>(metadataPath);
    if (!isSnapshotMetadata(value) || value.status !== "building" || value.name !== finding.snapshotName) {
      return undefined;
    }
    const projects = await inspectDockerProjects();
    if (projects.has(value.composeProject)) await removeDockerProject(value.composeProject);
    value.status = "failed";
    value.completedAt = new Date().toISOString();
    value.error = "Recovered by doctor after the snapshot build lost its owner.";
    await writeJsonAtomic(metadataPath, value);
    const failedPath = join(parent, `.failed-recovered-${safeSlug(value.name)}-${Date.now()}-${randomUUID().slice(0, 6)}`);
    await rename(target, failedPath);
    return failedPath;
  });
}

async function auditInvalidMetadata(repo: RepoInfo, findings: DoctorFinding[]): Promise<void> {
  for (const group of ["snapshots", "instances"] as const) {
    const root = join(repoDataRoot(repo), group);
    if (!(await pathExists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const metadataPath = join(root, entry.name, "metadata.json");
      let valid = await pathExists(metadataPath);
      if (valid) {
        try {
          const metadata = await readJson<unknown>(metadataPath);
          valid = group === "snapshots" ? isSnapshotMetadata(metadata) : isInstanceMetadata(metadata);
        } catch {
          valid = false;
        }
      }
      if (valid) continue;
      findings.push({
        code: "state-metadata-invalid",
        severity: "error",
        message: `Managed ${group.slice(0, -1)} state has missing or invalid metadata: ${metadataPath}`,
        fixable: false,
        target: entry.name,
      });
    }
  }
}

async function knownProjectNames(repo: RepoInfo): Promise<Set<string>> {
  const [instances, snapshots] = await Promise.all([listInstances(repo), listSnapshots(repo)]);
  const projects = new Set([
    ...instances.map(({ composeProject }) => composeProject),
    ...snapshots.map(({ composeProject }) => composeProject),
  ]);
  for (const project of await diagnosticProjectNames(repo)) projects.add(project);
  return projects;
}

async function diagnosticProjectNames(repo: RepoInfo): Promise<Set<string>> {
  const root = join(repoDataRoot(repo), "snapshots");
  const projects = new Set<string>();
  if (!(await pathExists(root))) return projects;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".")) continue;
    try {
      const metadata = await readJson<unknown>(join(root, entry.name, "metadata.json"));
      if (isSnapshotMetadata(metadata)) projects.add(metadata.composeProject);
    } catch {
      // Invalid diagnostic metadata cannot establish ownership.
    }
  }
  return projects;
}

async function removeDockerProject(project: string): Promise<void> {
  const containers = await dockerResourceIds("ps", ["-a", "-q"], project);
  if (containers.length > 0) await runCommand("docker", ["rm", "-f", ...containers]);

  const networks = await dockerResourceIds("network", ["ls", "-q"], project);
  for (const network of networks) {
    await runCommand("docker", ["network", "rm", network], { allowFailure: true });
  }

  const volumes = await dockerResourceIds("volume", ["ls", "-q"], project);
  for (const volume of volumes) {
    await runCommand("docker", ["volume", "rm", volume], { allowFailure: true });
  }
  if ((await inspectDockerProjects()).has(project)) {
    throw new BranchLiftError(`Docker resources for ${project} could not be removed completely.`);
  }
}

async function dockerResourceIds(group: string, args: string[], project: string): Promise<string[]> {
  const command = group === "ps" ? ["ps", ...args, "--filter", `label=com.docker.compose.project=${project}`] : [
    group,
    ...args,
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ];
  const result = await runCommand("docker", command, { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.split("\n").map((value) => value.trim()).filter(Boolean) : [];
}

function projectPrefix(repo: RepoInfo): string {
  return `bl-${repo.key.slice(-12)}-`;
}
