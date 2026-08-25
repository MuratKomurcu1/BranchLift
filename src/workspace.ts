import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { BranchLiftError } from "./errors.js";
import { recordEventBestEffort } from "./events.js";
import { pathExists, readJson, repoDataRoot, writeJsonAtomic } from "./paths.js";
import { runCommand } from "./process.js";
import { listInstances } from "./state.js";
import type { RepoInfo, WorkspaceTask, WorkspaceTaskStatus } from "./types.js";

const workspaceTaskStatuses = ["backlog", "ready", "running", "review", "done"] as const;
const maximumTasks = 500;
const maximumPromptLength = 20_000;
const tasksFile = "tasks.json";

export interface WorkspaceDiff {
  branch: string;
  worktreePath: string;
  status: string;
  stat: string;
  patch: string;
}

export async function listWorkspaceTasks(repo: RepoInfo): Promise<WorkspaceTask[]> {
  const path = workspaceTasksPath(repo);
  if (!(await pathExists(path))) return [];
  const value = await readJson<unknown>(path);
  if (!Array.isArray(value) || !value.every(isWorkspaceTask)) {
    throw new BranchLiftError(`Workspace task registry is invalid: ${path}`, "Restore or remove the private registry before continuing.");
  }
  return [...value].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createWorkspaceTask(
  repo: RepoInfo,
  input: { title: string; prompt: string; branch?: string; agent?: string; status?: WorkspaceTaskStatus },
): Promise<WorkspaceTask> {
  const tasks = await listWorkspaceTasks(repo);
  if (tasks.length >= maximumTasks) throw new BranchLiftError(`Workspace registry is limited to ${maximumTasks} tasks.`);
  const now = new Date().toISOString();
  const task: WorkspaceTask = {
    version: 1,
    id: randomUUID(),
    title: boundedText(input.title, "title", 120),
    prompt: boundedText(input.prompt, "prompt", maximumPromptLength),
    status: input.status ?? "backlog",
    createdAt: now,
    updatedAt: now,
    ...(input.branch === undefined || input.branch.trim() === "" ? {} : { branch: boundedText(input.branch, "branch", 300) }),
    ...(input.agent === undefined || input.agent.trim() === "" ? {} : { agent: boundedText(input.agent, "agent", 80) }),
  };
  await writeTasks(repo, [task, ...tasks]);
  await recordEventBestEffort(repo, "workspace.task.create", `Created workspace task ${task.title}.`, {
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    details: { taskId: task.id, status: task.status },
  });
  return task;
}

export async function moveWorkspaceTask(repo: RepoInfo, id: string, status: WorkspaceTaskStatus): Promise<WorkspaceTask> {
  assertTaskStatus(status);
  const tasks = await listWorkspaceTasks(repo);
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) throw new BranchLiftError(`Workspace task not found: ${id}`);
  const current = tasks[index]!;
  const updated: WorkspaceTask = { ...current, status, updatedAt: new Date().toISOString() };
  tasks[index] = updated;
  await writeTasks(repo, tasks);
  await recordEventBestEffort(repo, "workspace.task.move", `Moved ${updated.title} to ${status}.`, {
    ...(updated.branch === undefined ? {} : { branch: updated.branch }),
    details: { taskId: updated.id, status },
  });
  return updated;
}

export async function deleteWorkspaceTask(repo: RepoInfo, id: string): Promise<WorkspaceTask> {
  const tasks = await listWorkspaceTasks(repo);
  const task = tasks.find((entry) => entry.id === id);
  if (task === undefined) throw new BranchLiftError(`Workspace task not found: ${id}`);
  await writeTasks(repo, tasks.filter((entry) => entry.id !== id));
  await recordEventBestEffort(repo, "workspace.task.delete", `Deleted workspace task ${task.title}.`, {
    ...(task.branch === undefined ? {} : { branch: task.branch }),
    details: { taskId: task.id },
  });
  return task;
}

export async function inspectWorkspaceDiff(repo: RepoInfo, branch: string): Promise<WorkspaceDiff> {
  const instance = (await listInstances(repo)).find((entry) => entry.branch === branch);
  if (instance === undefined) throw new BranchLiftError(`Instance not found for workspace diff: ${branch}`);
  const root = resolve(instance.worktreePath);
  const repositoryRoot = resolve(repo.root);
  const managedRoot = resolve(repoDataRoot(repo), "..", "..", "worktrees", repo.key);
  const safeExternal = root === repositoryRoot || root.startsWith(`${repositoryRoot}${sep}`);
  const safeManaged = root === managedRoot || root.startsWith(`${managedRoot}${sep}`);
  if (!safeExternal && !safeManaged) throw new BranchLiftError(`Refusing to inspect a worktree outside the repository or BranchLift state: ${root}`);
  const [status, stat, patch] = await Promise.all([
    runCommand("git", ["status", "--short", "--untracked-files=all"], { cwd: root, maxOutputBytes: 512 * 1024 }),
    runCommand("git", ["diff", "--no-ext-diff", "--no-color", "--stat", "HEAD", "--"], { cwd: root, maxOutputBytes: 512 * 1024 }),
    runCommand("git", ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--"], { cwd: root, maxOutputBytes: 2 * 1024 * 1024 }),
  ]);
  return { branch, worktreePath: root, status: status.stdout, stat: stat.stdout, patch: patch.stdout };
}

export function parseWorkspaceTaskStatus(value: string): WorkspaceTaskStatus {
  assertTaskStatus(value);
  return value;
}

function workspaceTasksPath(repo: RepoInfo): string {
  return join(repoDataRoot(repo), "workspace", tasksFile);
}

async function writeTasks(repo: RepoInfo, tasks: WorkspaceTask[]): Promise<void> {
  await writeJsonAtomic(workspaceTasksPath(repo), tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
}

function boundedText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum || normalized.includes("\0")) {
    throw new BranchLiftError(`${name} must be between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function assertTaskStatus(value: string): asserts value is WorkspaceTaskStatus {
  if (!(workspaceTaskStatuses as readonly string[]).includes(value)) {
    throw new BranchLiftError(`Task status must be one of: ${workspaceTaskStatuses.join(", ")}.`);
  }
}

function isWorkspaceTask(value: unknown): value is WorkspaceTask {
  if (!isRecord(value)) return false;
  return value.version === 1
    && typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.prompt === "string"
    && (value.branch === undefined || typeof value.branch === "string")
    && (value.agent === undefined || typeof value.agent === "string")
    && typeof value.status === "string"
    && (workspaceTaskStatuses as readonly string[]).includes(value.status)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
