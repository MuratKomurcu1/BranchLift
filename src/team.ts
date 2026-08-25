import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { BranchLiftError } from "./errors.js";
import { pathExists, readJson, repoDataRoot, writeJsonAtomic } from "./paths.js";
import { listInstances, listSnapshots } from "./state.js";
import { listWorkspaceTasks } from "./workspace.js";
import type { RepoInfo, TeamRegistryNode, TeamRole, TeamTokenDefinition } from "./types.js";

const maximumTokens = 100;
const maximumRegistryBytes = 1024 * 1024;
const maximumRegistryItems = 1_000;
const roles = ["viewer", "operator", "admin"] as const;

export async function createTeamToken(
  repo: RepoInfo,
  label: string,
  role: TeamRole,
): Promise<{ token: string; definition: Omit<TeamTokenDefinition, "digest"> }> {
  assertTeamRole(role);
  const normalizedLabel = label.trim();
  if (normalizedLabel === "" || normalizedLabel.length > 80 || normalizedLabel.includes("\0")) {
    throw new BranchLiftError("Team token label must be between 1 and 80 characters.");
  }
  const definitions = await readTeamTokenDefinitions(repo);
  if (definitions.length >= maximumTokens) throw new BranchLiftError(`A repository may have at most ${maximumTokens} team tokens.`);
  const token = randomBytes(32).toString("base64url");
  const definition: TeamTokenDefinition = {
    version: 1,
    id: randomUUID(),
    label: normalizedLabel,
    role,
    digest: tokenDigest(token),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(teamTokensPath(repo), [definition, ...definitions]);
  const { digest: _digest, ...publicDefinition } = definition;
  return { token, definition: publicDefinition };
}

export async function listTeamTokens(repo: RepoInfo): Promise<Array<Omit<TeamTokenDefinition, "digest">>> {
  return (await readTeamTokenDefinitions(repo)).map(({ digest: _digest, ...definition }) => definition);
}

export async function revokeTeamToken(repo: RepoInfo, id: string): Promise<void> {
  const definitions = await readTeamTokenDefinitions(repo);
  if (!definitions.some((definition) => definition.id === id)) throw new BranchLiftError(`Team token not found: ${id}`);
  await writeJsonAtomic(teamTokensPath(repo), definitions.filter((definition) => definition.id !== id));
}

export async function authenticateTeamToken(repo: RepoInfo, token: string): Promise<TeamRole | undefined> {
  if (token.length < 32 || token.length > 256 || /\s/.test(token)) return undefined;
  const supplied = Buffer.from(tokenDigest(token), "hex");
  for (const definition of await readTeamTokenDefinitions(repo)) {
    const expected = Buffer.from(definition.digest, "hex");
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return definition.role;
  }
  return undefined;
}

export function teamRoleAllows(role: TeamRole, required: TeamRole): boolean {
  return roles.indexOf(role) >= roles.indexOf(required);
}

export function parseTeamRole(value: string): TeamRole {
  assertTeamRole(value);
  return value;
}

export async function publishTeamRegistry(repo: RepoInfo, directory: string): Promise<TeamRegistryNode> {
  const [instances, snapshots, tasks] = await Promise.all([
    listInstances(repo),
    listSnapshots(repo),
    listWorkspaceTasks(repo),
  ]);
  const host = hostname();
  const record: TeamRegistryNode = {
    version: 1,
    repository: { key: repo.key, name: repo.name },
    node: { id: createHash("sha256").update(`${repo.key}\0${host}`).digest("hex").slice(0, 20), hostname: host },
    updatedAt: new Date().toISOString(),
    environments: instances.map(({ branch, snapshot, status, ports }) => ({ branch, snapshot, status, ports })),
    snapshots: snapshots.map(({ name, parentSnapshot, createdAt, sizeBytes }) => ({
      name,
      createdAt,
      ...(parentSnapshot === undefined ? {} : { parentSnapshot }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    })),
    tasks: tasks.map(({ id, title, status, branch, agent, updatedAt }) => ({
      id,
      title,
      status,
      updatedAt,
      ...(branch === undefined ? {} : { branch }),
      ...(agent === undefined ? {} : { agent }),
    })),
  };
  const root = resolveRegistryDirectory(directory);
  await mkdir(root, { recursive: true });
  const path = join(root, `${repo.key}-${record.node.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, path);
  return record;
}

export async function listTeamRegistry(directory: string, repoKey?: string): Promise<TeamRegistryNode[]> {
  const root = resolveRegistryDirectory(directory);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const records: TeamRegistryNode[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    let handle;
    try {
      handle = await open(join(root, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maximumRegistryBytes) continue;
      const value = normalizeTeamRegistryNode(JSON.parse(await handle.readFile("utf8")) as unknown);
      if (value !== undefined && (repoKey === undefined || value.repository.key === repoKey)) records.push(value);
    } catch {
      // A partially synchronized peer record must not hide healthy nodes.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function readTeamTokenDefinitions(repo: RepoInfo): Promise<TeamTokenDefinition[]> {
  const path = teamTokensPath(repo);
  if (!(await pathExists(path))) return [];
  const value = await readJson<unknown>(path);
  if (!Array.isArray(value) || !value.every(isTeamTokenDefinition)) {
    throw new BranchLiftError(`Team token registry is invalid: ${path}`, "Restore or remove the private token registry before continuing.");
  }
  return value;
}

function teamTokensPath(repo: RepoInfo): string {
  return join(repoDataRoot(repo), "team", "tokens.json");
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function assertTeamRole(value: string): asserts value is TeamRole {
  if (!(roles as readonly string[]).includes(value)) throw new BranchLiftError(`Team role must be one of: ${roles.join(", ")}.`);
}

function isTeamTokenDefinition(value: unknown): value is TeamTokenDefinition {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.id === "string"
    && typeof value.label === "string"
    && typeof value.role === "string"
    && (roles as readonly string[]).includes(value.role)
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.createdAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveRegistryDirectory(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0")) throw new BranchLiftError("Team registry directory is invalid.");
  return resolve(normalized);
}

function normalizeTeamRegistryNode(value: unknown): TeamRegistryNode | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.repository) || !isRecord(value.node)) return undefined;
  if (!isBoundedString(value.repository.key, 200) || !isBoundedString(value.repository.name, 200)
    || !isBoundedString(value.node.id, 200) || !isBoundedString(value.node.hostname, 500)
    || !isTimestamp(value.updatedAt) || !isBoundedArray(value.environments)
    || !isBoundedArray(value.snapshots) || !isBoundedArray(value.tasks)) return undefined;

  const environments: TeamRegistryNode["environments"] = [];
  for (const item of value.environments) {
    if (!isRecord(item) || !isBoundedString(item.branch, 500) || !isBoundedString(item.snapshot, 200)
      || !isInstanceStatus(item.status) || !isBoundedArray(item.ports)) return undefined;
    const ports: TeamRegistryNode["environments"][number]["ports"] = [];
    for (const port of item.ports) {
      if (!isRecord(port) || !isBoundedString(port.service, 200) || !Number.isInteger(port.target)
        || (port.protocol !== "tcp" && port.protocol !== "udp") || !isBoundedString(port.host, 500)
        || !Number.isInteger(port.port) || (port.port as number) < 0 || (port.port as number) > 65_535) return undefined;
      ports.push({
        service: port.service,
        target: port.target as number,
        protocol: port.protocol,
        host: port.host,
        port: port.port as number,
      });
    }
    environments.push({ branch: item.branch, snapshot: item.snapshot, status: item.status, ports });
  }

  const snapshots: TeamRegistryNode["snapshots"] = [];
  for (const item of value.snapshots) {
    if (!isRecord(item) || !isBoundedString(item.name, 200) || !isTimestamp(item.createdAt)
      || (item.parentSnapshot !== undefined && !isBoundedString(item.parentSnapshot, 200))
      || (item.sizeBytes !== undefined && (!Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0))) return undefined;
    snapshots.push({
      name: item.name,
      createdAt: item.createdAt,
      ...(item.parentSnapshot === undefined ? {} : { parentSnapshot: item.parentSnapshot }),
      ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes as number }),
    });
  }

  const tasks: TeamRegistryNode["tasks"] = [];
  for (const item of value.tasks) {
    if (!isRecord(item) || !isBoundedString(item.id, 200) || !isBoundedString(item.title, 500)
      || !isWorkspaceTaskStatus(item.status) || !isTimestamp(item.updatedAt)
      || (item.branch !== undefined && !isBoundedString(item.branch, 500))
      || (item.agent !== undefined && !isBoundedString(item.agent, 200))) return undefined;
    tasks.push({
      id: item.id,
      title: item.title,
      status: item.status,
      updatedAt: item.updatedAt,
      ...(item.branch === undefined ? {} : { branch: item.branch }),
      ...(item.agent === undefined ? {} : { agent: item.agent }),
    });
  }

  return {
    version: 1,
    repository: { key: value.repository.key, name: value.repository.name },
    node: { id: value.node.id, hostname: value.node.hostname },
    updatedAt: value.updatedAt,
    environments,
    snapshots,
    tasks,
  };
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= maximumRegistryItems;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function isTimestamp(value: unknown): value is string {
  return isBoundedString(value, 100) && Number.isFinite(Date.parse(value));
}

function isInstanceStatus(value: unknown): value is TeamRegistryNode["environments"][number]["status"] {
  return value === "creating" || value === "running" || value === "stopped" || value === "failed";
}

function isWorkspaceTaskStatus(value: unknown): value is TeamRegistryNode["tasks"][number]["status"] {
  return value === "backlog" || value === "ready" || value === "running" || value === "review" || value === "done";
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
