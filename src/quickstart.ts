import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectConfiguredCompose, initializeConfig, loadConfig, configFileName } from "./config.js";
import { BranchLiftError } from "./errors.js";
import { discoverRepo } from "./git.js";
import { pathExists } from "./paths.js";
import { inspectPolicyTrust, trustSecurityPolicy } from "./policy.js";
import { runCommand } from "./process.js";
import { spawnInstance, startInstance } from "./runtime.js";
import { createSnapshot } from "./snapshot.js";
import { listInstances, listSnapshots } from "./state.js";
import type { InstanceMetadata, RepoInfo, SnapshotMetadata } from "./types.js";

export interface QuickstartResult {
  repository: string;
  configCreated: boolean;
  policyTrusted: boolean;
  snapshotCreated: boolean;
  instanceCreated: boolean;
  snapshot: SnapshotMetadata;
  instance: InstanceMetadata;
}

export async function quickstartRepository(
  repo: RepoInfo,
  options: { branch: string; snapshot?: string; start?: boolean; trustPolicy?: boolean },
): Promise<QuickstartResult> {
  const configPath = join(repo.root, configFileName);
  const configCreated = !(await pathExists(configPath));
  if (configCreated) await initializeConfig(repo);
  const config = await loadConfig(repo);
  const inspection = await inspectConfiguredCompose(repo, config);
  if (inspection.blockers.length > 0) {
    throw new BranchLiftError("Compose project is not safely cloneable.", inspection.blockers.map((item) => `- ${item}`).join("\n"));
  }
  const trust = options.trustPolicy === true
    ? await trustSecurityPolicy(repo, config)
    : await inspectPolicyTrust(repo, config);
  if (!trust.trusted) {
    throw new BranchLiftError(
      "Quickstart stopped before executing the repository's Compose policy.",
      `Review branchlift.yaml, then rerun with --trust-policy.\nPolicy: ${trust.digest}`,
    );
  }

  const snapshotName = options.snapshot ?? config.snapshot.default;
  const existingSnapshot = (await listSnapshots(repo)).find((entry) => entry.name === snapshotName);
  const snapshotCreated = existingSnapshot === undefined;
  const snapshot = existingSnapshot ?? (await createSnapshot(repo, config, inspection, snapshotName)).metadata;

  const existingInstance = (await listInstances(repo)).find((entry) => entry.branch === options.branch);
  let instanceCreated = false;
  let instance: InstanceMetadata;
  if (existingInstance === undefined) {
    instanceCreated = true;
    instance = await spawnInstance(repo, config, inspection, options.branch, {
      snapshot: snapshotName,
      start: options.start !== false,
      agentCommand: [],
    });
  } else {
    if (existingInstance.snapshot !== snapshotName) {
      throw new BranchLiftError(
        `Branch ${options.branch} already uses snapshot ${existingInstance.snapshot}.`,
        "Choose another branch or omit --snapshot to reuse the existing environment.",
      );
    }
    instance = options.start !== false && existingInstance.status === "stopped"
      ? await startInstance(repo, config, inspection, options.branch, { agentCommand: [], quiet: true })
      : existingInstance;
  }
  return {
    repository: repo.root,
    configCreated,
    policyTrusted: trust.trusted,
    snapshotCreated,
    instanceCreated,
    snapshot,
    instance,
  };
}

export async function scaffoldDemoProject(directory: string): Promise<RepoInfo> {
  const root = resolve(directory);
  if (await pathExists(root)) throw new BranchLiftError(`Demo directory already exists: ${root}`, "Choose an empty destination.");
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "compose.yaml"), demoCompose, { flag: "wx" }),
    writeFile(join(root, ".gitignore"), ".env\n", { flag: "wx" }),
    writeFile(join(root, "README.md"), demoReadme, { flag: "wx" }),
  ]);
  await runCommand("git", ["init", "--initial-branch=main"], { cwd: root });
  await runCommand("git", ["config", "user.name", "BranchLift Demo"], { cwd: root });
  await runCommand("git", ["config", "user.email", "demo@branchlift.local"], { cwd: root });
  await runCommand("git", ["add", "."], { cwd: root });
  await runCommand("git", ["commit", "-m", "chore: initialize BranchLift demo"], { cwd: root });
  return await discoverRepo(root);
}

const demoCompose = `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: branchlift
      POSTGRES_USER: branchlift
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U branchlift -d app"]
      interval: 2s
      timeout: 2s
      retries: 30
    volumes:
      - postgres-data:/var/lib/postgresql/data
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 30
    volumes:
      - redis-data:/data

volumes:
  postgres-data:
  redis-data:
`;

const demoReadme = `# BranchLift demo

This disposable project demonstrates isolated PostgreSQL and Redis state for a Git branch.

Run \`branchlift quickstart agent/demo --trust-policy\`, then \`branchlift ui\`.
`;
