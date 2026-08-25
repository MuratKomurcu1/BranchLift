import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { BranchLiftError } from "./errors.js";
import { pathExists } from "./paths.js";
import type { RepoInfo } from "./types.js";

export type AgentName = "codex" | "claude" | "cursor";

export interface AgentInstallResult {
  agent: AgentName;
  path: string;
  changed: boolean;
  kind: "hook" | "mcp";
}

const hookCommand = "branchlift hook attach";

export async function installAgentIntegrations(
  repo: RepoInfo,
  agents: AgentName[],
  write: boolean,
): Promise<AgentInstallResult[]> {
  const results: AgentInstallResult[] = [];
  for (const agent of agents) {
    if (agent === "codex") results.push(...await installCodex(repo, write));
    else if (agent === "claude") results.push(...await installClaude(repo, write));
    else results.push(...await installCursor(repo, write));
  }
  return results;
}

export function parseAgentName(value: string): AgentName[] {
  if (value === "all") return ["codex", "claude", "cursor"];
  if (value === "codex" || value === "claude" || value === "cursor") return [value];
  throw new BranchLiftError(`Unknown agent: ${value}`, "Use codex, claude, cursor, or all.");
}

export function displayInstallPath(repo: RepoInfo, path: string): string {
  return relative(repo.root, path) || ".";
}

async function installCodex(repo: RepoInfo, write: boolean): Promise<AgentInstallResult[]> {
  const hooksPath = join(repo.root, ".codex", "hooks.json");
  const hooks = await readJsonObject(hooksPath);
  const changedHook = mergeNestedHook(hooks, "SessionStart", {
    matcher: "startup|resume",
    hooks: [{
      type: "command",
      command: `${hookCommand} --format claude`,
      statusMessage: "Preparing BranchLift backend",
      timeout: 180,
      additionalContextLimit: 2500,
    }],
  });
  if (changedHook && write) await writeJson(hooksPath, hooks);

  const configPath = join(repo.root, ".codex", "config.toml");
  const existing = await readText(configPath);
  const hasMcp = /^\s*\[mcp_servers\.branchlift]\s*$/m.test(existing);
  const block = [
    "[mcp_servers.branchlift]",
    'command = "branchlift"',
    'args = ["mcp"]',
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 180",
  ].join("\n");
  if (!hasMcp && write) await writeText(configPath, appendBlock(existing, block));
  return [
    { agent: "codex", path: hooksPath, changed: changedHook, kind: "hook" },
    { agent: "codex", path: configPath, changed: !hasMcp, kind: "mcp" },
  ];
}

async function installClaude(repo: RepoInfo, write: boolean): Promise<AgentInstallResult[]> {
  const settingsPath = join(repo.root, ".claude", "settings.json");
  const settings = await readJsonObject(settingsPath);
  const changedHook = mergeNestedHook(settings, "SessionStart", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: `${hookCommand} --format claude`, timeout: 180 }],
  });
  if (changedHook && write) await writeJson(settingsPath, settings);

  const mcpPath = join(repo.root, ".mcp.json");
  const mcp = await readJsonObject(mcpPath);
  const changedMcp = mergeMcpServer(mcp);
  if (changedMcp && write) await writeJson(mcpPath, mcp);
  return [
    { agent: "claude", path: settingsPath, changed: changedHook, kind: "hook" },
    { agent: "claude", path: mcpPath, changed: changedMcp, kind: "mcp" },
  ];
}

async function installCursor(repo: RepoInfo, write: boolean): Promise<AgentInstallResult[]> {
  const hooksPath = join(repo.root, ".cursor", "hooks.json");
  const hooks = await readJsonObject(hooksPath);
  if (hooks.version === undefined) hooks.version = 1;
  const changedHook = mergeFlatHook(hooks, "sessionStart", {
    command: `${hookCommand} --format cursor`,
    timeout: 180,
  });
  if (changedHook && write) await writeJson(hooksPath, hooks);

  const mcpPath = join(repo.root, ".cursor", "mcp.json");
  const mcp = await readJsonObject(mcpPath);
  const changedMcp = mergeMcpServer(mcp);
  if (changedMcp && write) await writeJson(mcpPath, mcp);
  return [
    { agent: "cursor", path: hooksPath, changed: changedHook, kind: "hook" },
    { agent: "cursor", path: mcpPath, changed: changedMcp, kind: "mcp" },
  ];
}

function mergeNestedHook(root: Record<string, unknown>, event: string, definition: Record<string, unknown>): boolean {
  const hooks = objectField(root, "hooks");
  const entries = arrayField(hooks, event);
  if (entries.some(hasBranchLiftHook)) return false;
  entries.push(definition);
  return true;
}

function mergeFlatHook(root: Record<string, unknown>, event: string, definition: Record<string, unknown>): boolean {
  const hooks = objectField(root, "hooks");
  const entries = arrayField(hooks, event);
  if (entries.some(hasBranchLiftHook)) return false;
  entries.push(definition);
  return true;
}

function hasBranchLiftHook(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.command === "string" && value.command.includes(hookCommand)) return true;
  return Array.isArray(value.hooks) && value.hooks.some(hasBranchLiftHook);
}

function mergeMcpServer(root: Record<string, unknown>): boolean {
  const servers = objectField(root, "mcpServers");
  if (servers.branchlift !== undefined) return false;
  servers.branchlift = { command: "branchlift", args: ["mcp"] };
  return true;
}

function objectField(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = root[key];
  if (current === undefined) {
    const created: Record<string, unknown> = {};
    root[key] = created;
    return created;
  }
  if (!isRecord(current)) throw new BranchLiftError(`Cannot merge agent config: ${key} must be an object.`);
  return current;
}

function arrayField(root: Record<string, unknown>, key: string): unknown[] {
  const current = root[key];
  if (current === undefined) {
    const created: unknown[] = [];
    root[key] = created;
    return created;
  }
  if (!Array.isArray(current)) throw new BranchLiftError(`Cannot merge agent config: ${key} must be an array.`);
  return current;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!(await pathExists(path))) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("top level must be an object");
    return parsed;
  } catch (error) {
    throw new BranchLiftError(`Cannot safely merge invalid JSON: ${path}`, error instanceof Error ? error.message : String(error));
  }
}

async function readText(path: string): Promise<string> {
  return await pathExists(path) ? await readFile(path, "utf8") : "";
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { mode: 0o600 });
}

function appendBlock(existing: string, block: string): string {
  const prefix = existing.trimEnd();
  return `${prefix === "" ? "" : `${prefix}\n\n`}${block}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
