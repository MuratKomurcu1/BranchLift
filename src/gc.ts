import { directorySize, instanceRoot } from "./paths.js";
import { destroyInstanceIfUnchanged } from "./runtime.js";
import { listInstances } from "./state.js";
import type { InstanceMetadata, RepoInfo } from "./types.js";

export interface GarbageCollectionEntry {
  branch: string;
  status: InstanceMetadata["status"];
  updatedAt: string;
  worktreeOwner: "branchlift" | "external";
  logicalBytes: number;
  action: "would-remove" | "removed" | "skipped";
  reason?: string;
}

export interface GarbageCollectionResult {
  dryRun: boolean;
  olderThanMs: number;
  cutoff: string;
  scanned: number;
  eligible: number;
  removed: number;
  reclaimedBytes: number;
  entries: GarbageCollectionEntry[];
}

export async function collectGarbage(
  repo: RepoInfo,
  options: { olderThanMs: number; dryRun: boolean; now?: number },
): Promise<GarbageCollectionResult> {
  const now = options.now ?? Date.now();
  const cutoffMs = now - options.olderThanMs;
  const instances = await listInstances(repo);
  const candidates = instances.filter((instance) => {
    if (instance.status !== "stopped" && instance.status !== "failed") return false;
    const updated = Date.parse(instance.updatedAt);
    return Number.isFinite(updated) && updated <= cutoffMs;
  });
  const entries: GarbageCollectionEntry[] = [];
  let reclaimedBytes = 0;

  for (const instance of candidates) {
    const logicalBytes = await directorySize(instanceRoot(repo, instance.slug)).catch(() => 0);
    const base = {
      branch: instance.branch,
      status: instance.status,
      updatedAt: instance.updatedAt,
      worktreeOwner: instance.worktreeOwner ?? "branchlift" as const,
      logicalBytes,
    };
    if (options.dryRun) {
      entries.push({ ...base, action: "would-remove" });
      continue;
    }
    try {
      const result = await destroyInstanceIfUnchanged(
        repo,
        { branch: instance.branch, status: instance.status, updatedAt: instance.updatedAt },
        (instance.worktreeOwner ?? "branchlift") === "branchlift",
      );
      if (result.removed) {
        reclaimedBytes += logicalBytes;
        entries.push({ ...base, action: "removed" });
      } else {
        entries.push({ ...base, action: "skipped", reason: result.reason });
      }
    } catch (error) {
      entries.push({
        ...base,
        action: "skipped",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    dryRun: options.dryRun,
    olderThanMs: options.olderThanMs,
    cutoff: new Date(cutoffMs).toISOString(),
    scanned: instances.length,
    eligible: candidates.length,
    removed: entries.filter((entry) => entry.action === "removed").length,
    reclaimedBytes,
    entries,
  };
}

export function parseAge(value: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim().toLowerCase());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const unit = match[2];
  const multiplier = unit === "ms"
    ? 1
    : unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 604_800_000;
  const milliseconds = amount * multiplier;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}
