import { createInterface } from "node:readline";
import { currentBranch } from "./git.js";
import { inspectConfiguredCompose, loadConfig } from "./config.js";
import { BranchLiftError } from "./errors.js";
import { previewInstances, readInstanceLogs } from "./preview.js";
import { ensureAttachedInstance, instanceContext } from "./runtime.js";
import { listInstances } from "./state.js";
import type { RepoInfo } from "./types.js";
import { version } from "./version.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const tools = [
  {
    name: "branchlift_attach",
    description: "Attach an isolated copy of the configured backend state to the current Git worktree. Reuses an existing healthy attachment.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot: { type: "string", description: "Snapshot name; defaults to branchlift.yaml." },
        start: { type: "boolean", description: "Start the Compose stack; defaults to true." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Attach BranchLift backend", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "branchlift_list",
    description: "List BranchLift backend instances for this repository.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List BranchLift instances", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "branchlift_preview",
    description: "Inspect instance endpoints and live Docker service/health states when Docker is reachable.",
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string", description: "Optional exact Git branch name." } },
      additionalProperties: false,
    },
    annotations: { title: "Preview BranchLift endpoints", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "branchlift_logs",
    description: "Read recent Docker Compose logs from a BranchLift instance.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", description: "Git branch name; defaults to the current branch." },
        service: { type: "string", description: "Optional Compose service name." },
        tail: { type: "integer", minimum: 1, maximum: 10000, default: 200 },
        timestamps: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { title: "Read BranchLift logs", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
] as const;

export async function runMcpServer(repo: RepoInfo): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let response: JsonRpcResponse | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      response = await handleMcpRequest(repo, parsed);
    } catch (error) {
      response = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error", data: errorMessage(error) },
      };
    }
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

export async function handleMcpRequest(repo: RepoInfo, value: unknown): Promise<JsonRpcResponse | undefined> {
  if (!isRequest(value)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const id = value.id ?? null;
  if (value.id === undefined) return undefined;
  try {
    if (value.method === "initialize") {
      const params = record(value.params);
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "branchlift", version },
          instructions: "Use branchlift_attach before tests that need backend state. Use branchlift_preview for exact ports and health, and branchlift_logs to diagnose startup or test failures. BranchLift instances are isolated per Git branch.",
        },
      };
    }
    if (value.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (value.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
    if (value.method === "tools/call") {
      const params = record(value.params);
      const name = stringValue(params.name, "tool name");
      const args = record(params.arguments);
      try {
        const result = await callTool(repo, name, args);
        return { jsonrpc: "2.0", id, result: toolResult(result) };
      } catch (error) {
        return { jsonrpc: "2.0", id, result: toolResult({ error: errorMessage(error) }, true) };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${value.method}` } };
  } catch (error) {
    return { jsonrpc: "2.0", id, error: { code: -32602, message: errorMessage(error) } };
  }
}

async function callTool(repo: RepoInfo, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "branchlift_attach") {
    assertKeys(args, ["snapshot", "start"]);
    const config = await loadConfig(repo);
    const inspection = await inspectConfiguredCompose(repo, config);
    const branch = await currentBranch(repo);
    const snapshot = optionalString(args.snapshot, "snapshot") ?? config.snapshot.default;
    const start = optionalBoolean(args.start, "start") ?? true;
    const ensured = await ensureAttachedInstance(repo, config, inspection, branch, { snapshot, start, quiet: true });
    return { action: ensured.action, ...instanceContext(ensured.instance) };
  }
  if (name === "branchlift_list") {
    assertKeys(args, []);
    return await listInstances(repo);
  }
  if (name === "branchlift_preview") {
    assertKeys(args, ["branch"]);
    return await previewInstances(repo, optionalString(args.branch, "branch"));
  }
  if (name === "branchlift_logs") {
    assertKeys(args, ["branch", "service", "tail", "timestamps"]);
    const branch = optionalString(args.branch, "branch") ?? await currentBranch(repo);
    const tail = optionalInteger(args.tail, "tail") ?? 200;
    if (tail < 1 || tail > 10000) throw new BranchLiftError("tail must be between 1 and 10000.");
    const service = optionalString(args.service, "service");
    return {
      branch,
      logs: await readInstanceLogs(repo, branch, {
        ...(service === undefined ? {} : { service }),
        tail,
        follow: false,
        timestamps: optionalBoolean(args.timestamps, "timestamps") ?? false,
      }),
    };
  }
  throw new BranchLiftError(`Unknown MCP tool: ${name}`);
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  return value.id === undefined || value.id === null || typeof value.id === "string" || typeof value.id === "number";
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new BranchLiftError("Expected an object.");
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new BranchLiftError(`${name} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new BranchLiftError(`${name} must be a boolean.`);
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new BranchLiftError(`${name} must be an integer.`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new BranchLiftError(`Unexpected argument: ${unexpected}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof BranchLiftError) return [error.message, error.hint].filter(Boolean).join("\n");
  return error instanceof Error ? error.message : String(error);
}
