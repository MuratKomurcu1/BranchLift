import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { effectiveSecurity } from "./config.js";
import { BranchLiftError } from "./errors.js";
import { instanceRoot, pathExists, repoDataRoot } from "./paths.js";
import { assertSecurityPolicyTrusted } from "./policy.js";
import { runCommand } from "./process.js";
import type { BranchLiftConfig, RepoInfo, SecretDefinition, SecretScope } from "./types.js";

export interface ResolvedSecret {
  name: string;
  target: SecretDefinition["target"];
  value: string;
  scopes: SecretScope[];
}

export interface SecretStatus {
  name: string;
  source: "env" | "file" | "command";
  target: string;
  scopes: SecretScope[];
  required: boolean;
  available: boolean;
  message: string;
}

export interface ComposeSecretSession {
  envFile?: string;
  close(): Promise<void>;
}

export async function createComposeSecretSession(repo: RepoInfo, config: BranchLiftConfig): Promise<ComposeSecretSession> {
  const secrets = await resolveSecrets(repo, config, "compose");
  if (secrets.length === 0) return { close: async () => undefined };
  const root = join(repoDataRoot(repo), "operations", randomUUID());
  const envFile = join(root, "compose.env");
  await writeSecretEnvFile(envFile, secrets);
  return {
    envFile,
    close: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function resolveSecrets(
  repo: RepoInfo,
  config: BranchLiftConfig,
  scope: SecretScope,
): Promise<ResolvedSecret[]> {
  const definitions = config.secrets ?? {};
  if (Object.values(definitions).some((definition) => definition.scopes.includes(scope))) {
    await assertSecurityPolicyTrusted(repo, config);
  }
  const resolved: ResolvedSecret[] = [];
  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition.scopes.includes(scope)) continue;
    const value = await resolveSecretValue(repo, config, name, definition);
    if (value === undefined) {
      if (definition.required) throw new BranchLiftError(`Required secret is unavailable: ${name}`);
      continue;
    }
    assertSafeSecretValue(name, value, "env" in definition.target);
    resolved.push({ name, target: definition.target, value, scopes: definition.scopes });
  }
  return resolved;
}

export function mergeSecretEnvironment(base: NodeJS.ProcessEnv, secrets: ResolvedSecret[]): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const secret of secrets) if ("env" in secret.target) env[secret.target.env] = secret.value;
  return env;
}

export async function materializeSecretEnv(
  repo: RepoInfo,
  slug: string,
  secrets: ResolvedSecret[],
): Promise<string | undefined> {
  if (secrets.length === 0) return undefined;
  const path = join(instanceRoot(repo, slug), "secrets", "compose.env");
  await writeSecretEnvFile(path, secrets);
  return path;
}

export async function writeSecretEnvFile(path: string, secrets: ResolvedSecret[]): Promise<void> {
  await writeSecretEnv(path, secrets, escapeEnvValue);
}

/**
 * Writes KEY=VALUE pairs for consumers that read values verbatim, such as
 * `docker run --env-file`, which performs no `$$` interpolation. Compose
 * interpolation files must use writeSecretEnvFile instead.
 */
export async function writePlainSecretEnvFile(path: string, secrets: ResolvedSecret[]): Promise<void> {
  await writeSecretEnv(path, secrets, (value) => value);
}

async function writeSecretEnv(
  path: string,
  secrets: ResolvedSecret[],
  encodeValue: (value: string) => string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const environmentSecrets = secrets.filter((secret): secret is ResolvedSecret & { target: { env: string } } => "env" in secret.target);
  if (environmentSecrets.length !== secrets.length) throw new BranchLiftError("File-target secrets cannot be written as an environment file.");
  const content = environmentSecrets.map(({ target, value }) => `${target.env}=${encodeValue(value)}`).join("\n");
  await writeFile(path, `${content}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function redactInstanceText(repo: RepoInfo, slug: string, text: string): Promise<string> {
  const path = join(instanceRoot(repo, slug), "secrets", "compose.env");
  return await redactEnvFileText(path, text);
}

export async function redactEnvFileText(path: string | undefined, text: string): Promise<string> {
  if (path === undefined) return text;
  if (!(await pathExists(path))) return text;
  const values = parseEnvValues(await readFile(path, "utf8"));
  return redactText(text, values);
}

export function redactText(text: string, values: Iterable<string>): string {
  const candidates = [...new Set([...values].filter((value) => value.length >= 4))].sort((left, right) => right.length - left.length);
  let result = text;
  for (const value of candidates) result = result.split(value).join("[REDACTED]");
  return result;
}

export async function inspectSecrets(repo: RepoInfo, config: BranchLiftConfig): Promise<SecretStatus[]> {
  const results: SecretStatus[] = [];
  for (const [name, definition] of Object.entries(config.secrets ?? {})) {
    if ("env" in definition.source) {
      const available = process.env[definition.source.env] !== undefined;
      results.push(status(name, definition, "env", available, available ? "available in the current environment" : `missing ${definition.source.env}`));
    } else if ("file" in definition.source) {
      const path = resolveSecretFile(repo, definition.source.file);
      const available = await pathExists(path);
      let message = available ? `available at ${displaySecretPath(path)}` : `missing ${displaySecretPath(path)}`;
      if (available) {
        const mode = (await stat(path)).mode & 0o777;
        if ((mode & 0o077) !== 0) message += `; permissions ${mode.toString(8)} are broader than 600`;
      }
      results.push(status(name, definition, "file", available, message));
    } else {
      const allowed = effectiveSecurity(config).allowSecretCommands;
      results.push(status(
        name,
        definition,
        "command",
        allowed,
        allowed ? "command source enabled; value is resolved only when needed" : "blocked by security.allowSecretCommands",
      ));
    }
  }
  return results;
}

async function resolveSecretValue(
  repo: RepoInfo,
  config: BranchLiftConfig,
  name: string,
  definition: SecretDefinition,
): Promise<string | undefined> {
  if ("env" in definition.source) return process.env[definition.source.env];
  if ("file" in definition.source) {
    const path = resolveSecretFile(repo, definition.source.file);
    if (!(await pathExists(path))) return undefined;
    return (await readSecretFile(repo, definition.source.file, path)).replace(/[\r\n]+$/, "");
  }
  if (!effectiveSecurity(config).allowSecretCommands) {
    throw new BranchLiftError(
      `Secret ${name} uses a host command source, but command sources are disabled.`,
      "Set security.allowSecretCommands: true only after reviewing the committed command.",
    );
  }
  const [command, ...args] = definition.source.command;
  if (command === undefined) throw new BranchLiftError(`Secret command is empty: ${name}`);
  const result = await runCommand(command, args, {
    cwd: repo.root,
    allowFailure: true,
    maxOutputBytes: "env" in definition.target ? 64 * 1024 : 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    if (!definition.required) return undefined;
    throw new BranchLiftError(`Secret command failed: ${name}`, result.stderr.trim() || `exit ${result.exitCode}`);
  }
  return result.stdout.replace(/[\r\n]+$/, "");
}

function resolveSecretFile(repo: RepoInfo, value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(repo.root, value);
}

async function readSecretFile(repo: RepoInfo, configuredPath: string, path: string): Promise<string> {
  if (isAbsolute(configuredPath) || configuredPath === "~" || configuredPath.startsWith("~/")) {
    return await readFile(path, "utf8");
  }
  const repository = await realpath(repo.root);
  const candidate = resolve(repository, configuredPath);
  const relativePath = relative(repository, candidate);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new BranchLiftError(`Repository-relative secret path escapes the repository: ${configuredPath}`);
  }
  let current = repository;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new BranchLiftError(`Repository-relative secret path must not contain symlinks: ${configuredPath}`);
    }
  }
  const canonical = await realpath(candidate);
  const canonicalRelative = relative(repository, canonical);
  if (canonicalRelative === "" || canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
    throw new BranchLiftError(`Repository-relative secret path resolves outside the repository: ${configuredPath}`);
  }
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new BranchLiftError(`Secret source must be a regular file: ${configuredPath}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertSafeSecretValue(name: string, value: string, environmentTarget: boolean): void {
  if (value === "") throw new BranchLiftError(`Secret ${name} resolved to an empty value.`);
  if (value.includes("\0") || (environmentTarget && (value.includes("\n") || value.includes("\r")))) {
    throw new BranchLiftError(`Secret ${name} contains a newline or NUL byte and cannot be safely injected as an environment variable.`);
  }
  const limit = environmentTarget ? 64 * 1024 : 1024 * 1024;
  if (Buffer.byteLength(value) > limit) throw new BranchLiftError(`Secret ${name} exceeds the ${environmentTarget ? "64 KiB" : "1 MiB"} safety limit.`);
}

function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, () => "\\\\").replace(/\$/g, () => "$$");
}

function parseEnvValues(value: string): string[] {
  return value.split("\n").flatMap((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [] : [line.slice(index + 1).replace(/\$\$/g, "$").replace(/\\\\/g, "\\")];
  });
}

function status(
  name: string,
  definition: SecretDefinition,
  source: SecretStatus["source"],
  available: boolean,
  message: string,
): SecretStatus {
  return {
    name,
    source,
    target: "env" in definition.target ? `env:${definition.target.env}` : `file:${definition.target.file}`,
    scopes: definition.scopes,
    required: definition.required,
    available,
    message,
  };
}

function displaySecretPath(path: string): string {
  return path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path;
}
