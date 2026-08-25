import { mkdir, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { volumeDirectoryName } from "./compose.js";
import { cloneDirectory, copyDirectoryFull, repoDataRoot, snapshotRoot } from "./paths.js";
import { readSnapshotMetadata } from "./state.js";
import type { CopyStrategy, RepoInfo } from "./types.js";

export interface BenchmarkResult {
  snapshot: string;
  iterations: number;
  logicalBytes: number;
  strategy: CopyStrategy;
  cloneSamplesMs: number[];
  fullCopySamplesMs: number[];
  cloneMedianMs: number;
  cloneP95Ms: number;
  fullCopyMedianMs: number;
  speedup: number;
}

export async function benchmarkSnapshot(repo: RepoInfo, name: string, iterations: number): Promise<BenchmarkResult> {
  const snapshot = await readSnapshotMetadata(repo, name);
  const benchmarkRoot = join(repoDataRoot(repo), "benchmarks", randomUUID());
  await mkdir(benchmarkRoot, { recursive: true });
  const cloneSamples: number[] = [];
  const fullCopySamples: number[] = [];
  let strategy: CopyStrategy = "empty";

  try {
    for (let index = 0; index < iterations; index += 1) {
      const cloneRoot = join(benchmarkRoot, `${index}-clone`);
      const copyRoot = join(benchmarkRoot, `${index}-full-copy`);
      const runClone = async (): Promise<void> => {
        await mkdir(cloneRoot, { recursive: true });
        const started = performance.now();
        const strategies = await Promise.all(snapshot.volumeNames.map(async (volume) => {
          const source = join(snapshotRoot(repo, name), "volumes", volumeDirectoryName(volume));
          const destination = join(cloneRoot, volumeDirectoryName(volume));
          return await cloneDirectory(source, destination);
        }));
        strategy = strategies.reduce(mergeStrategies, strategy);
        cloneSamples.push(performance.now() - started);
        await rm(cloneRoot, { recursive: true, force: true });
      };
      const runFullCopy = async (): Promise<void> => {
        await mkdir(copyRoot, { recursive: true });
        const started = performance.now();
        await Promise.all(snapshot.volumeNames.map(async (volume) => {
          const source = join(snapshotRoot(repo, name), "volumes", volumeDirectoryName(volume));
          const destination = join(copyRoot, volumeDirectoryName(volume));
          await copyDirectoryFull(source, destination);
        }));
        fullCopySamples.push(performance.now() - started);
        await rm(copyRoot, { recursive: true, force: true });
      };
      // Alternate order to reduce warm-cache and first-run bias.
      if (index % 2 === 0) {
        await runFullCopy();
        await runClone();
      } else {
        await runClone();
        await runFullCopy();
      }
    }
  } finally {
    const managedParent = resolve(repoDataRoot(repo), "benchmarks");
    const resolved = resolve(benchmarkRoot);
    if (resolved.startsWith(`${managedParent}/`)) await rm(resolved, { recursive: true, force: true });
  }

  const sortedClones = [...cloneSamples].sort((left, right) => left - right);
  const sortedCopies = [...fullCopySamples].sort((left, right) => left - right);
  const cloneMedianMs = percentile(sortedClones, 0.5);
  const fullCopyMedianMs = percentile(sortedCopies, 0.5);
  return {
    snapshot: name,
    iterations,
    logicalBytes: snapshot.sizeBytes ?? 0,
    strategy,
    cloneSamplesMs: cloneSamples.map(round),
    fullCopySamplesMs: fullCopySamples.map(round),
    cloneMedianMs: round(cloneMedianMs),
    cloneP95Ms: round(percentile(sortedClones, 0.95)),
    fullCopyMedianMs: round(fullCopyMedianMs),
    speedup: round(cloneMedianMs === 0 ? 0 : fullCopyMedianMs / cloneMedianMs),
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
