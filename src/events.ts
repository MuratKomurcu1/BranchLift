import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateStateRoot, repoDataRoot } from "./paths.js";
import type { AuditEvent, AuditEventLevel, RepoInfo } from "./types.js";

const maximumEventLogBytes = 5 * 1024 * 1024;

export interface RecordEventOptions {
  level?: AuditEventLevel;
  branch?: string;
  snapshot?: string;
  details?: Record<string, unknown>;
}

export function eventLogPath(repo: RepoInfo): string {
  return join(repoDataRoot(repo), "events.jsonl");
}

export async function recordEvent(
  repo: RepoInfo,
  kind: string,
  message: string,
  options: RecordEventOptions = {},
): Promise<AuditEvent> {
  const event: AuditEvent = {
    version: 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    repoKey: repo.key,
    kind: safeKind(kind),
    level: options.level ?? "info",
    message: clamp(message, 1000),
    ...(options.branch === undefined ? {} : { branch: clamp(options.branch, 300) }),
    ...(options.snapshot === undefined ? {} : { snapshot: clamp(options.snapshot, 300) }),
    ...(options.details === undefined ? {} : { details: sanitizeDetails(options.details) }),
  };
  const path = eventLogPath(repo);
  await ensurePrivateStateRoot();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(path);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(`${JSON.stringify(event)}\n`);
  } finally {
    await handle.close();
  }
  return event;
}

export async function recordEventBestEffort(
  repo: RepoInfo,
  kind: string,
  message: string,
  options: RecordEventOptions = {},
): Promise<void> {
  await recordEvent(repo, kind, message, options).catch(() => undefined);
}

export async function listEvents(repo: RepoInfo, limit = 200): Promise<AuditEvent[]> {
  const bounded = Math.max(1, Math.min(limit, 2000));
  let raw: string;
  try {
    raw = await readFile(eventLogPath(repo), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-bounded)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return isAuditEvent(value) ? [value] : [];
      } catch {
        return [];
      }
    })
    .reverse();
}

function safeKind(value: string): string {
  const kind = value.toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 100);
  return kind || "unknown";
}

function sanitizeDetails(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(value, 0) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return clamp(value, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    result[key] = /secret|token|password|credential|authorization|cookie/i.test(key)
      ? "[redacted]"
      : sanitizeValue(item, depth + 1);
  }
  return result;
}

async function rotateIfNeeded(path: string): Promise<void> {
  try {
    if ((await stat(path)).size < maximumEventLogBytes) return;
    await rename(path, `${path}.${Date.now()}`);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1
    && typeof item.id === "string"
    && typeof item.timestamp === "string"
    && typeof item.repoKey === "string"
    && typeof item.kind === "string"
    && ["info", "warning", "error"].includes(String(item.level))
    && typeof item.message === "string";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
