import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { findComposeFile, findComposeFiles, inspectCompose, relativeComposePath } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import { pathExists } from "./paths.js";
import type { ComposeInspection, BranchLiftConfig, RepoInfo, SeedStep } from "./types.js";

export const configFileName = "branchlift.yaml";

export async function initializeConfig(
  repo: RepoInfo,
  requestedCompose?: string | string[],
  options: { write?: boolean } = {},
): Promise<{ config: BranchLiftConfig; inspection: ComposeInspection; path: string; written: boolean }> {
  const path = join(repo.root, configFileName);
  const write = options.write !== false;
  if (write && await pathExists(path)) {
    throw new BranchLiftError(`${configFileName} already exists.`, "Edit the existing file or run branchlift inspect.");
  }
  const requested = requestedCompose === undefined ? undefined : Array.isArray(requestedCompose) ? requestedCompose : [requestedCompose];
  const composeFiles = requested === undefined
    ? await findComposeFiles(repo.root)
    : await Promise.all(requested.map(async (file) => await findComposeFile(repo.root, file)));
  const inspection = await inspectCompose(composeFiles);
  const copyFiles: string[] = [];
  for (const candidate of [".env", ".env.local"]) {
    if (await pathExists(join(repo.root, candidate))) copyFiles.push(candidate);
  }
  const config: BranchLiftConfig = {
    version: 1,
    compose: {
      files: composeFiles.map((file) => relativeComposePath(repo.root, file)),
      statefulServices: inspection.inferredStatefulServices,
    },
    snapshot: {
      default: "dev",
      healthTimeoutSeconds: 120,
      seed: [],
    },
    worktree: {
      copyFiles,
    },
  };
  if (write) {
    const preamble = "# BranchLift project configuration. Commit this file.\n";
    await writeFile(path, `${preamble}${stringify(config, { indent: 2 })}`, { flag: "wx" });
  }
  return { config, inspection, path, written: write };
}

export async function loadConfig(repo: RepoInfo): Promise<BranchLiftConfig> {
  const path = join(repo.root, configFileName);
  if (!(await pathExists(path))) {
    throw new BranchLiftError(`${configFileName} not found.`, "Run branchlift init first.");
  }
  let raw: unknown;
  try {
    raw = parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BranchLiftError(`Unable to parse ${configFileName}.`, detail);
  }
  if (!isMap(raw) || raw.version !== 1) throw new BranchLiftError(`Unsupported or invalid ${configFileName}.`);

  const compose = requireMap(raw.compose, "compose");
  const snapshot = requireMap(raw.snapshot, "snapshot");
  const worktree = requireMap(raw.worktree, "worktree");
  const files = compose.files === undefined
    ? [requireString(compose.file, "compose.file")]
    : stringArray(compose.files, "compose.files");
  if (files.length === 0) throw new BranchLiftError("compose.files must contain at least one file.");
  const statefulServices = stringArray(compose.statefulServices, "compose.statefulServices");
  const defaultSnapshot = requireString(snapshot.default, "snapshot.default");
  const healthTimeoutSeconds = requirePositiveInteger(snapshot.healthTimeoutSeconds, "snapshot.healthTimeoutSeconds");
  const copyFiles = stringArray(worktree.copyFiles, "worktree.copyFiles");
  const seed = parseSeed(snapshot.seed);

  return {
    version: 1,
    compose: { files: [...new Set(files)], statefulServices },
    snapshot: { default: defaultSnapshot, healthTimeoutSeconds, seed },
    worktree: { copyFiles },
  };
}

export async function inspectConfiguredCompose(
  repo: RepoInfo,
  config: BranchLiftConfig,
): Promise<ComposeInspection> {
  const files = config.compose.files.map((file) => resolve(repo.root, file));
  for (const [index, file] of files.entries()) {
    relativeComposePath(repo.root, file);
    if (!(await pathExists(file))) {
      throw new BranchLiftError(`Configured Compose file not found: ${config.compose.files[index]}`);
    }
  }
  const inspection = await inspectCompose(files);
  for (const service of config.compose.statefulServices) {
    if (!inspection.services.includes(service)) {
      inspection.blockers.push(`Configured stateful service does not exist: ${service}`);
    } else if (!inspection.volumes.some((volume) => volume.service === service)) {
      inspection.blockers.push(`Configured stateful service ${service} has no managed named volume to snapshot.`);
    }
    if (!inspection.inferredStatefulServices.includes(service)) {
      for (const mount of inspection.bindMounts.filter((item) => item.service === service && !item.readOnly && item.sharedAcrossWorktrees)) {
        const blocker = `Configured stateful service ${service} uses shared writable bind ${mount.source} -> ${mount.target}.`;
        if (!inspection.blockers.includes(blocker)) inspection.blockers.push(blocker);
        const recommendation = `Use a worktree-local relative path, a read-only bind, or a managed named volume for ${service}:${mount.target}.`;
        if (!inspection.recommendations.includes(recommendation)) inspection.recommendations.push(recommendation);
      }
    }
  }
  for (const seed of config.snapshot.seed) {
    if (!inspection.services.includes(seed.service)) {
      inspection.blockers.push(`Snapshot seed service does not exist: ${seed.service}`);
      inspection.recommendations.push(`Change snapshot.seed service ${seed.service} to a service declared by Compose.`);
    }
  }
  return inspection;
}

function parseSeed(value: unknown): SeedStep[] {
  if (!Array.isArray(value)) throw new BranchLiftError("snapshot.seed must be an array.");
  return value.map((item, index) => {
    const map = requireMap(item, `snapshot.seed[${index}]`);
    const command = stringArray(map.command, `snapshot.seed[${index}].command`);
    if (command.length === 0) throw new BranchLiftError(`snapshot.seed[${index}].command must not be empty.`);
    return {
      service: requireString(map.service, `snapshot.seed[${index}].service`),
      command,
    };
  });
}

function requireMap(value: unknown, name: string): Record<string, unknown> {
  if (!isMap(value)) throw new BranchLiftError(`${name} must be a mapping.`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new BranchLiftError(`${name} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new BranchLiftError(`${name} must be an array of non-empty strings.`);
  }
  return value as string[];
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BranchLiftError(`${name} must be a positive integer.`);
  }
  return value;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
