import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { findComposeFile, inspectCompose, relativeComposePath } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import { pathExists } from "./paths.js";
import type { ComposeInspection, BranchLiftConfig, RepoInfo, SeedStep } from "./types.js";

export const configFileName = "branchlift.yaml";

export async function initializeConfig(
  repo: RepoInfo,
  requestedCompose?: string | string[],
): Promise<{ config: BranchLiftConfig; inspection: ComposeInspection; path: string }> {
  const path = join(repo.root, configFileName);
  if (await pathExists(path)) {
    throw new BranchLiftError(`${configFileName} already exists.`, "Edit the existing file or run branchlift inspect.");
  }
  const requested = requestedCompose === undefined ? undefined : Array.isArray(requestedCompose) ? requestedCompose : [requestedCompose];
  const composeFiles = requested === undefined
    ? [await findComposeFile(repo.root)]
    : await Promise.all(requested.map(async (file) => await findComposeFile(repo.root, file)));
  const inspection = await inspectCompose(composeFiles);
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
      copyFiles: [".env"],
    },
  };
  const preamble = "# BranchLift project configuration. Commit this file.\n";
  await writeFile(path, `${preamble}${stringify(config, { indent: 2 })}`, { flag: "wx" });
  return { config, inspection, path };
}

export async function loadConfig(repo: RepoInfo): Promise<BranchLiftConfig> {
  const path = join(repo.root, configFileName);
  if (!(await pathExists(path))) {
    throw new BranchLiftError(`${configFileName} not found.`, "Run branchlift init first.");
  }
  const raw = parse(await readFile(path, "utf8")) as unknown;
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
  }
  return inspection;
}

function parseSeed(value: unknown): SeedStep[] {
  if (!Array.isArray(value)) throw new BranchLiftError("snapshot.seed must be an array.");
  return value.map((item, index) => {
    const map = requireMap(item, `snapshot.seed[${index}]`);
    return {
      service: requireString(map.service, `snapshot.seed[${index}].service`),
      command: stringArray(map.command, `snapshot.seed[${index}].command`),
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
