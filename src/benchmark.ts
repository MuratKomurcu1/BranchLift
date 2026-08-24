import { mkdir, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { volumeDirectoryName } from "./compose.js";
import { cloneDirectory, repoDataRoot, snapshotRoot } from "./paths.js";
import { readSnapshotMetadata } from "./state.js";
import type { CopyStrategy, RepoInfo } from "./types.js";

export interface BenchmarkResult {
  snapshot: string;
  iterations: number;
  logicalBytes: number;
  strategy: CopyStrategy;
  samplesMs: number[];
  medianMs: number;
  p95Ms: number;
}

export async function benchmarkSnapshot(repo: RepoInfo, name: string, iterations: number): Promise<BenchmarkResult> {
  const snapshot = await readSnapshotMetadata(repo, name);
  const benchmarkRoot = join(repoDataRoot(repo), "benchmarks", randomUUID());
  await mkdir(benchmarkRoot, { recursive: true });
  const samples: number[] = [];
  let strategy: CopyStrategy = "empty";

  try {
    for (let index = 0; index < iterations; index += 1) {
      const destinationRoot = join(benchmarkRoot, String(index));
      await mkdir(destinationRoot, { recursive: true });
      const started = performance.now();
      for (const volume of snapshot.volumeNames) {
        const source = join(snapshotRoot(repo, name), "volumes", volumeDirectoryName(volume));
        const destination = join(destinationRoot, volumeDirectoryName(volume));
        strategy = mergeStrategies(strategy, await cloneDirectory(source, destination));
      }
      samples.push(performance.now() - started);
      await rm(destinationRoot, { recursive: true, force: true });
    }
  } finally {
    const managedParent = resolve(repoDataRoot(repo), "benchmarks");
    const resolved = resolve(benchmarkRoot);
    if (resolved.startsWith(`${managedParent}/`)) await rm(resolved, { recursive: true, force: true });
  }

  const sorted = [...samples].sort((left, right) => left - right);
  return {
    snapshot: name,
    iterations,
    logicalBytes: snapshot.sizeBytes ?? 0,
    strategy,
    samplesMs: samples.map(round),
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
  };
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function mergeStrategies(current: CopyStrategy, next: CopyStrategy): CopyStrategy {
  if (current === "recursive-copy" || next === "recursive-copy") return "recursive-copy";
  if (current === "empty") return next;
  return current;
}
