import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { findComposeFile, findComposeFiles, inspectCompose, relativeComposePath } from "./compose.js";
import { BranchLiftError } from "./errors.js";
import { pathExists } from "./paths.js";
import type {
  ComposeInspection,
  BranchLiftConfig,
  RepoInfo,
  SandboxBackend,
  SandboxNetwork,
  SecretDefinition,
  SecretScope,
  SeedStep,
  SecurityConfig,
  UiConfig,
} from "./types.js";

export const configFileName = "branchlift.yaml";

export const defaultSecurityConfig: SecurityConfig = {
  sandbox: {
    backend: "docker",
    image: "node:22-bookworm-slim",
    network: "backend",
    readOnlyRoot: true,
    memory: "4g",
    cpus: 2,
    pidsLimit: 512,
  },
  allowHostAgentCommands: false,
  allowSecretCommands: false,
};

export const defaultUiConfig: UiConfig = { host: "127.0.0.1", port: 7788 };

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
  const security = raw.security === undefined ? undefined : parseSecurity(raw.security);
  const secrets = raw.secrets === undefined ? undefined : parseSecrets(raw.secrets);
  const ui = raw.ui === undefined ? undefined : parseUi(raw.ui);

  return {
    version: 1,
    compose: { files: [...new Set(files)], statefulServices },
    snapshot: { default: defaultSnapshot, healthTimeoutSeconds, seed },
    worktree: { copyFiles },
    ...(security === undefined ? {} : { security }),
    ...(secrets === undefined ? {} : { secrets }),
    ...(ui === undefined ? {} : { ui }),
  };
}

export function effectiveSecurity(config: BranchLiftConfig): SecurityConfig {
  return config.security ?? structuredClone(defaultSecurityConfig);
}

export function effectiveUi(config: BranchLiftConfig): UiConfig {
  return config.ui ?? { ...defaultUiConfig };
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

function parseSecurity(value: unknown): SecurityConfig {
  const map = requireMap(value, "security");
  assertKnownKeys(map, ["sandbox", "allowHostAgentCommands", "allowSecretCommands"], "security");
  const sandbox = requireMap(map.sandbox, "security.sandbox");
  assertKnownKeys(
    sandbox,
    ["backend", "image", "network", "readOnlyRoot", "memory", "cpus", "pidsLimit"],
    "security.sandbox",
  );
  const backend = enumValue(sandbox.backend, ["docker", "host"] as const, "security.sandbox.backend");
  const network = enumValue(sandbox.network, ["none", "backend", "outbound"] as const, "security.sandbox.network");
  return {
    sandbox: {
      backend: backend as SandboxBackend,
      image: requireString(sandbox.image, "security.sandbox.image"),
      network: network as SandboxNetwork,
      readOnlyRoot: requireBoolean(sandbox.readOnlyRoot, "security.sandbox.readOnlyRoot"),
      memory: requireString(sandbox.memory, "security.sandbox.memory"),
      cpus: requirePositiveNumber(sandbox.cpus, "security.sandbox.cpus"),
      pidsLimit: requirePositiveInteger(sandbox.pidsLimit, "security.sandbox.pidsLimit"),
    },
    allowHostAgentCommands: requireBoolean(map.allowHostAgentCommands, "security.allowHostAgentCommands"),
    allowSecretCommands: requireBoolean(map.allowSecretCommands, "security.allowSecretCommands"),
  };
}

function parseSecrets(value: unknown): Record<string, SecretDefinition> {
  const map = requireMap(value, "secrets");
  const result: Record<string, SecretDefinition> = {};
  for (const [name, raw] of Object.entries(map)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new BranchLiftError(`Invalid secret name: ${name}`);
    const item = requireMap(raw, `secrets.${name}`);
    assertKnownKeys(item, ["source", "target", "scopes", "required"], `secrets.${name}`);
    const source = requireMap(item.source, `secrets.${name}.source`);
    assertKnownKeys(source, ["env", "file", "command"], `secrets.${name}.source`);
    const sourceKinds = ["env", "file", "command"].filter((key) => source[key] !== undefined);
    if (sourceKinds.length !== 1) {
      throw new BranchLiftError(`secrets.${name}.source must define exactly one of env, file, or command.`);
    }
    let parsedSource: SecretDefinition["source"];
    if (source.env !== undefined) parsedSource = { env: requireEnvironmentName(source.env, `secrets.${name}.source.env`) };
    else if (source.file !== undefined) parsedSource = { file: requireString(source.file, `secrets.${name}.source.file`) };
    else {
      const command = stringArray(source.command, `secrets.${name}.source.command`);
      if (command.length === 0) throw new BranchLiftError(`secrets.${name}.source.command must not be empty.`);
      parsedSource = { command };
    }
    const target = requireMap(item.target, `secrets.${name}.target`);
    assertKnownKeys(target, ["env", "file"], `secrets.${name}.target`);
    const targetKinds = ["env", "file"].filter((key) => target[key] !== undefined);
    if (targetKinds.length !== 1) {
      throw new BranchLiftError(`secrets.${name}.target must define exactly one of env or file.`);
    }
    const rawScopes = stringArray(item.scopes, `secrets.${name}.scopes`);
    const scopes = rawScopes.map((scope) => enumValue(
      scope,
      ["compose", "exec", "agent", "sandbox"] as const,
      `secrets.${name}.scopes`,
    ) as SecretScope);
    if (scopes.length === 0) throw new BranchLiftError(`secrets.${name}.scopes must not be empty.`);
    const parsedTarget: SecretDefinition["target"] = target.env !== undefined
      ? { env: requireEnvironmentName(target.env, `secrets.${name}.target.env`) }
      : { file: requireSecretTargetFile(target.file, `secrets.${name}.target.file`) };
    if ("file" in parsedTarget && scopes.some((scope) => scope !== "sandbox")) {
      throw new BranchLiftError(`secrets.${name} file targets currently support only the sandbox scope.`);
    }
    result[name] = {
      source: parsedSource,
      target: parsedTarget,
      scopes: [...new Set(scopes)],
      required: requireBoolean(item.required, `secrets.${name}.required`),
    };
  }
  return result;
}

function parseUi(value: unknown): UiConfig {
  const map = requireMap(value, "ui");
  assertKnownKeys(map, ["host", "port"], "ui");
  return {
    host: enumValue(map.host, ["127.0.0.1", "::1"] as const, "ui.host"),
    port: requirePort(map.port, "ui.port"),
  };
}

function requireMap(value: unknown, name: string): Record<string, unknown> {
  if (!isMap(value)) throw new BranchLiftError(`${name} must be a mapping.`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new BranchLiftError(`${name} must be a non-empty string.`);
  return value;
}

function requireEnvironmentName(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new BranchLiftError(`${name} must be a valid environment variable name.`);
  return result;
}

function requireSecretTargetFile(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (!result.startsWith("/run/secrets/") || !/^\/run\/secrets\/[A-Za-z0-9._/-]+$/.test(result)) {
    throw new BranchLiftError(`${name} must be an absolute path below /run/secrets/.`);
  }
  const segments = result.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".") || result.endsWith("/")) {
    throw new BranchLiftError(`${name} must be a normalized secret file path.`);
  }
  return result;
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

function requirePositiveNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BranchLiftError(`${name} must be a positive number.`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new BranchLiftError(`${name} must be a boolean.`);
  return value;
}

function requirePort(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new BranchLiftError(`${name} must be an integer between 0 and 65535.`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new BranchLiftError(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T[number];
}

function assertKnownKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new BranchLiftError(`${name}.${unexpected} is not supported.`);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
