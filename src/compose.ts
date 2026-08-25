import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { BranchLiftError } from "./errors.js";
import { pathExists, safeSlug } from "./paths.js";
import { runCommand } from "./process.js";
import type { BindMount, ComposeInspection, PortBinding, VolumeBinding } from "./types.js";

type UnknownMap = Record<string, unknown>;

const composeCandidates = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const composeOverrides: Record<string, string[]> = {
  "compose.yaml": ["compose.override.yaml", "compose.override.yml"],
  "compose.yml": ["compose.override.yml", "compose.override.yaml"],
  "docker-compose.yaml": ["docker-compose.override.yaml", "docker-compose.override.yml"],
  "docker-compose.yml": ["docker-compose.override.yml", "docker-compose.override.yaml"],
};
const statefulPattern = /(?:^|[\/_-])(postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|minio|clickhouse|kafka|redpanda|rabbitmq|nats|qdrant|weaviate|elasticsearch|opensearch)(?::|$|[\/_-])/i;

export async function findComposeFile(root: string, requested?: string): Promise<string> {
  if (requested !== undefined) {
    const absolute = resolve(root, requested);
    if (!(await pathExists(absolute))) throw new BranchLiftError(`Compose file not found: ${requested}`);
    return absolute;
  }
  for (const candidate of composeCandidates) {
    const absolute = join(root, candidate);
    if (await pathExists(absolute)) return absolute;
  }
  throw new BranchLiftError(
    "No Compose file found.",
    `Expected one of: ${composeCandidates.join(", ")}. Pass an explicit path with --compose.`,
  );
}

export async function findComposeFiles(root: string): Promise<string[]> {
  const base = await findComposeFile(root);
  const candidates = composeOverrides[relative(root, base)] ?? [];
  for (const candidate of candidates) {
    const override = join(root, candidate);
    if (await pathExists(override)) return [base, override];
  }
  return [base];
}

export async function inspectCompose(input: string | string[]): Promise<ComposeInspection> {
  const files = (Array.isArray(input) ? input : [input]).map((file) => resolve(file));
  if (files.length === 0) throw new BranchLiftError("At least one Compose file is required.");
  const document = files.length === 1 ? await readComposeDocument(files[0]!) : await readMergedComposeDocument(files);
  if (!isMap(document)) throw new BranchLiftError(`Invalid Compose document: ${files.join(", ")}`);
  const serviceMap = isMap(document.services) ? document.services : undefined;
  if (serviceMap === undefined || Object.keys(serviceMap).length === 0) {
    throw new BranchLiftError(`Compose project has no services: ${files.join(", ")}`);
  }

  const topVolumes = isMap(document.volumes) ? document.volumes : {};
  const externalVolumes = new Set<string>();
  for (const [name, definition] of Object.entries(topVolumes)) {
    if (isMap(definition) && (definition.external === true || typeof definition.external === "object")) {
      externalVolumes.add(name);
    }
  }

  const services = Object.keys(serviceMap).sort();
  const volumes: VolumeBinding[] = [];
  const bindMounts: BindMount[] = [];
  const ports: PortBinding[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];
  const inferredStatefulServices: string[] = [];
  const postgresServices: string[] = [];
  const postgresDataDirectories: Record<string, string> = {};
  const mysqlServices: string[] = [];
  const serviceCommands: Record<string, string | string[]> = {};

  for (const [serviceName, rawService] of Object.entries(serviceMap)) {
    if (!isMap(rawService)) {
      blockers.push(`Service ${serviceName} is not a mapping.`);
      continue;
    }
    const image = typeof rawService.image === "string" ? rawService.image : "";
    if (typeof rawService.command === "string") serviceCommands[serviceName] = rawService.command;
    else if (Array.isArray(rawService.command) && rawService.command.every((item) => typeof item === "string")) {
      serviceCommands[serviceName] = rawService.command;
    }
    const stateful = statefulPattern.test(`/${serviceName}`) || statefulPattern.test(`/${image}`);
    if (stateful) inferredStatefulServices.push(serviceName);
    if (/(?:^|[\/_-])postgres(?:ql)?(?::|$|[\/_-])/i.test(`/${image}`)) {
      postgresServices.push(serviceName);
      const pgdata = environmentValue(rawService.environment, "PGDATA");
      if (pgdata !== undefined && pgdata !== "") postgresDataDirectories[serviceName] = pgdata;
    }
    if (/(?:^|[\/_-])mysql(?::|$|[\/_-])/i.test(`/${image}`)) mysqlServices.push(serviceName);

    if (typeof rawService.container_name === "string") {
      blockers.push(`Service ${serviceName} sets container_name; fixed names collide across worktrees.`);
      recommendations.push(`Remove ${serviceName}.container_name and let Compose derive a project-scoped container name.`);
    }
    if (rawService.network_mode === "host") {
      blockers.push(`Service ${serviceName} uses host networking and cannot be port-isolated.`);
      recommendations.push(`Replace ${serviceName}.network_mode: host with normal Compose networking and declared ports.`);
    }
    if (rawService.pid === "host" || rawService.ipc === "host") {
      warnings.push(`Service ${serviceName} shares a host namespace (${rawService.pid === "host" ? "pid" : "ipc"}).`);
    }

    const serviceVolumes = Array.isArray(rawService.volumes) ? rawService.volumes : [];
    let namedVolumeCount = 0;
    for (const rawVolume of serviceVolumes) {
      const mount = parseVolume(rawVolume, serviceName, externalVolumes);
      if (mount === undefined) {
        const description = describeUnsupportedMount(rawVolume);
        warnings.push(`Service ${serviceName} has ${description}; BranchLift leaves it under Compose control.`);
        continue;
      }
      if ("external" in mount) {
        namedVolumeCount += 1;
        volumes.push(mount);
        if (mount.external) {
          blockers.push(`Volume ${mount.source} used by ${serviceName} is external and cannot be cloned safely.`);
          recommendations.push(`Make ${mount.source} a project-managed named volume or remove it from statefulServices.`);
        }
      } else {
        bindMounts.push(mount);
        if (!mount.readOnly && mount.sharedAcrossWorktrees) {
          const message = `Shared writable bind mount ${mount.source} -> ${serviceName}:${mount.target} can leak state across worktrees.`;
          if (stateful) blockers.push(message);
          else warnings.push(message);
          recommendations.push(`Use a relative worktree-local path, a read-only bind, or a managed named volume for ${serviceName}:${mount.target}.`);
        }
      }
    }
    if (stateful && namedVolumeCount === 0) {
      blockers.push(`Stateful service ${serviceName} has no managed named volume to snapshot.`);
      recommendations.push(`Mount the durable data directory of ${serviceName} from a non-external named volume.`);
    }

    const servicePorts = Array.isArray(rawService.ports) ? rawService.ports : [];
    for (const rawPort of servicePorts) {
      const parsed = parsePort(rawPort, serviceName);
      if (parsed !== undefined && !ports.some((port) => samePort(port, parsed))) ports.push(parsed);
    }
  }

  const usedVolumeNames = new Set(volumes.map((volume) => volume.source));
  for (const name of Object.keys(topVolumes)) {
    if (!usedVolumeNames.has(name)) warnings.push(`Top-level volume ${name} is declared but not mounted by a service.`);
  }

  return {
    file: files.join(", "),
    files,
    services,
    inferredStatefulServices: inferredStatefulServices.sort(),
    postgresServices: postgresServices.sort(),
    postgresDataDirectories,
    mysqlServices: mysqlServices.sort(),
    serviceCommands,
    volumes,
    bindMounts,
    ports,
    blockers: unique(blockers),
    warnings: unique(warnings),
    recommendations: unique(recommendations),
  };
}

async function readComposeDocument(file: string): Promise<unknown> {
  try {
    return parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BranchLiftError(`Unable to parse Compose file: ${file}`, detail);
  }
}

async function readMergedComposeDocument(files: string[]): Promise<unknown> {
  const args = ["compose"];
  for (const file of files) args.push("-f", file);
  args.push("config", "--format", "json");
  let result;
  try {
    result = await runCommand("docker", args, { cwd: dirname(files[0]!) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BranchLiftError("Unable to merge the configured Compose files.", detail);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new BranchLiftError("Docker Compose returned an invalid merged project model.", result.stderr.trim());
  }
}

export function generateOverride(
  inspection: ComposeInspection,
  volumeRoot: string,
  options: {
    randomizePorts: boolean;
    postgresHostUser?: { uid: number; gid: number } | false;
    postgresDataDirectories?: ReadonlyMap<string, string | false>;
    mysqlHostUser?: { uid: number; gid: number } | false;
    bindHostUser?: { uid: number; gid: number } | false;
    hostUserServices?: ReadonlySet<string>;
    mysqlLowerCaseTableNames?: 0 | 1 | 2 | false;
    nativeVolumes?: ReadonlyMap<string, string>;
  },
): string {
  const postgresHostUser = options.postgresHostUser === false
    ? undefined
    : options.postgresHostUser ?? localPostgresBindUser();
  const mysqlHostUser = options.mysqlHostUser === false
    ? undefined
    : options.mysqlHostUser ?? localMysqlBindUser();
  const bindHostUser = options.bindHostUser === false
    ? undefined
    : options.bindHostUser ?? localBindUser();
  const hostUserServices = options.hostUserServices ?? new Set<string>();
  const mysqlLowerCaseTableNames = options.mysqlLowerCaseTableNames === false
    ? undefined
    : options.mysqlLowerCaseTableNames ?? 1;
  const nativeVolumes = options.nativeVolumes ?? new Map<string, string>();
  const postgresDataDirectories = options.postgresDataDirectories;
  const byService = new Map<string, VolumeBinding[]>();
  for (const volume of inspection.volumes) {
    const existing = byService.get(volume.service) ?? [];
    existing.push(volume);
    byService.set(volume.service, existing);
  }

  const portsByService = new Map<string, PortBinding[]>();
  if (options.randomizePorts) {
    for (const port of inspection.ports) {
      const existing = portsByService.get(port.service) ?? [];
      existing.push(port);
      portsByService.set(port.service, existing);
    }
  }

  const affected = new Set([...byService.keys(), ...portsByService.keys()]);
  const lines = ["# Generated by BranchLift. Do not edit.", "services:"];
  for (const service of [...affected].sort()) {
    lines.push(`  ${quote(service)}:`);
    const serviceVolumes = byService.get(service) ?? [];
    if (serviceVolumes.length > 0) {
      // Compose merges mounts by container target, so replacing only managed
      // targets preserves unrelated bind, tmpfs, secret, and config mounts.
      lines.push("    volumes:");
      for (const volume of serviceVolumes) {
        const nativeVolume = nativeVolumes.get(volume.source);
        lines.push(`      - type: ${nativeVolume === undefined ? "bind" : "volume"}`);
        lines.push(
          `        source: ${quote(nativeVolume === undefined ? join(volumeRoot, volumeDirectoryName(volume.source)) : volume.source)}`,
        );
        lines.push(`        target: ${quote(volume.target)}`);
        if (volume.readOnly) lines.push("        read_only: true");
      }
    }
    if (inspection.postgresServices.includes(service) && serviceVolumes.length > 0) {
      const dataVolume = selectPostgresDataVolume(serviceVolumes);
      if (dataVolume !== undefined) {
        const configured = postgresDataDirectories?.has(service) === true
          ? postgresDataDirectories.get(service)
          : `${dataVolume.target}/.branchlift-pgdata`;
        if (configured !== false && configured !== undefined) {
          lines.push("    environment:");
          lines.push(`      PGDATA: ${quote(configured)}`);
        }
      }
      if (postgresHostUser !== undefined) {
        lines.push(`    user: ${quote(`${postgresHostUser.uid}:${postgresHostUser.gid}`)}`);
        lines.push("    tmpfs:");
        lines.push(
          `      - ${quote(`/var/run/postgresql:uid=${postgresHostUser.uid},gid=${postgresHostUser.gid},mode=3775`)}`,
        );
      }
    }
    if (inspection.mysqlServices.includes(service) && serviceVolumes.length > 0) {
      if (mysqlHostUser !== undefined) lines.push(`    user: ${quote(`${mysqlHostUser.uid}:${mysqlHostUser.gid}`)}`);
      if (mysqlLowerCaseTableNames !== undefined) {
        const command = withServiceArgument(
          inspection.serviceCommands[service],
          "--lower-case-table-names=",
          `--lower-case-table-names=${mysqlLowerCaseTableNames}`,
        );
        lines.push(`    command: ${Array.isArray(command) ? JSON.stringify(command) : quote(command)}`);
      }
    }
    const hasWritableBind = serviceVolumes.some(
      (volume) => !volume.readOnly && !nativeVolumes.has(volume.source),
    );
    if (
      bindHostUser !== undefined
      && hasWritableBind
      && hostUserServices.has(service)
      && !inspection.postgresServices.includes(service)
      && !inspection.mysqlServices.includes(service)
    ) {
      lines.push(`    user: ${quote(`${bindHostUser.uid}:${bindHostUser.gid}`)}`);
    }
    const servicePorts = portsByService.get(service) ?? [];
    if (servicePorts.length > 0) {
      lines.push("    ports: !override");
      for (const port of servicePorts) {
        lines.push(`      - target: ${port.target}`);
        lines.push(`        protocol: ${port.protocol}`);
        // BranchLift environments are local control-plane resources. Even if
        // the source Compose file publishes on every interface, randomized
        // instance ports stay loopback-only.
        lines.push(`        host_ip: ${quote(loopbackHost(port.hostIp))}`);
      }
    }
  }
  if (nativeVolumes.size > 0) {
    lines.push("volumes:");
    for (const [source, name] of [...nativeVolumes].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`  ${quote(source)}:`);
      lines.push(`    name: ${quote(name)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function localPostgresBindUser(): { uid: number; gid: number } | undefined {
  return localBindUser();
}

export function localMysqlBindUser(): { uid: number; gid: number } | undefined {
  return localBindUser();
}

function localBindUser(): { uid: number; gid: number } | undefined {
  if (!new Set(["darwin", "linux"]).has(process.platform) || process.getuid === undefined || process.getgid === undefined) return undefined;
  const uid = process.getuid();
  const gid = process.getgid();
  return uid > 0 ? { uid, gid } : undefined;
}

function environmentValue(value: unknown, name: string): string | undefined {
  if (isMap(value)) {
    const found = value[name];
    return typeof found === "string" || typeof found === "number" ? String(found) : undefined;
  }
  if (Array.isArray(value)) {
    const prefix = `${name}=`;
    const found = value.find((item) => typeof item === "string" && item.startsWith(prefix));
    return typeof found === "string" ? found.slice(prefix.length) : undefined;
  }
  return undefined;
}

export function postgresDataVolumeNames(inspection: ComposeInspection): string[] {
  return [...new Set(postgresDataVolumes(inspection).map((volume) => volume.source))].sort();
}

export function postgresDataVolumes(inspection: ComposeInspection): VolumeBinding[] {
  const found: VolumeBinding[] = [];
  for (const service of inspection.postgresServices) {
    const dataVolume = selectPostgresDataVolume(inspection.volumes.filter((volume) => volume.service === service));
    if (dataVolume !== undefined) found.push(dataVolume);
  }
  return found;
}

export function mysqlDataVolumes(inspection: ComposeInspection): VolumeBinding[] {
  const found: VolumeBinding[] = [];
  for (const service of inspection.mysqlServices) {
    const dataVolume = selectMysqlDataVolume(inspection.volumes.filter((volume) => volume.service === service));
    if (dataVolume !== undefined) found.push(dataVolume);
  }
  return found;
}

export function volumeDirectoryName(volume: string): string {
  return safeSlug(volume);
}

export function relativeComposePath(root: string, file: string): string {
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(file);
  const value = relative(resolvedRoot, resolvedFile);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new BranchLiftError(`Compose file must be inside the repository: ${file}`);
  }
  return value;
}

function parseVolume(
  value: unknown,
  service: string,
  externalVolumes: Set<string>,
): VolumeBinding | BindMount | undefined {
  if (typeof value === "string") {
    const parts = value.split(":");
    if (parts.length < 2) return undefined;
    const possibleMode = parts.at(-1) ?? "";
    const hasMode = /^(?:ro|rw|z|Z|cached|delegated|consistent)(?:,.*)?$/.test(possibleMode);
    const targetIndex = hasMode ? parts.length - 2 : parts.length - 1;
    const target = parts[targetIndex];
    const source = parts.slice(0, targetIndex).join(":");
    if (!target || !source) return undefined;
    const readOnly = hasMode && possibleMode.split(",").includes("ro");
    if (isBindSource(source)) {
      return { source, target, service, readOnly, sharedAcrossWorktrees: isSharedBindSource(source) };
    }
    return { source, target, service, readOnly, external: externalVolumes.has(source) };
  }

  if (!isMap(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : "volume";
  const source = typeof value.source === "string" ? value.source : undefined;
  const target = typeof value.target === "string" ? value.target : undefined;
  if (source === undefined || target === undefined) return undefined;
  if (type === "bind") {
    return {
      source,
      target,
      service,
      readOnly: value.read_only === true,
      sharedAcrossWorktrees: isSharedBindSource(source),
    };
  }
  if (type !== "volume") return undefined;
  return {
    source,
    target,
    service,
    readOnly: value.read_only === true,
    external: externalVolumes.has(source),
  };
}

function parsePort(value: unknown, service: string): PortBinding | undefined {
  if (typeof value === "number") return { service, target: value, protocol: "tcp" };
  if (typeof value === "string") {
    const [withoutProtocol = "", protocolValue = "tcp"] = value.split("/");
    const targetValue = withoutProtocol.split(":").at(-1);
    const target = Number.parseInt(targetValue ?? "", 10);
    if (!Number.isInteger(target) || target <= 0 || target > 65535) return undefined;
    const protocol = protocolValue === "udp" ? "udp" : "tcp";
    return { service, target, protocol };
  }
  if (isMap(value)) {
    const target = typeof value.target === "number" ? value.target : Number.parseInt(String(value.target ?? ""), 10);
    if (!Number.isInteger(target) || target <= 0 || target > 65535) return undefined;
    const hostIp = typeof value.host_ip === "string" ? value.host_ip : undefined;
    return {
      service,
      target,
      protocol: value.protocol === "udp" ? "udp" : "tcp",
      ...(hostIp === undefined ? {} : { hostIp }),
    };
  }
  return undefined;
}

function loopbackHost(value: string | undefined): "127.0.0.1" | "::1" {
  return value === "::1" || value === "[::1]" ? "::1" : "127.0.0.1";
}

function isBindSource(source: string): boolean {
  return source.includes("${") || source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || /^[A-Za-z]:[\\/]/.test(source);
}

function isSharedBindSource(source: string): boolean {
  return source.includes("${")
    || source === ".."
    || source.startsWith("../")
    || source.startsWith("..\\")
    || isAbsolute(source)
    || source.startsWith("~")
    || /^[A-Za-z]:[\\/]/.test(source);
}

function describeUnsupportedMount(value: unknown): string {
  if (typeof value === "string" && !value.includes(":")) return `an anonymous volume at ${value}`;
  if (isMap(value) && typeof value.type === "string") return `an unsupported ${value.type} mount`;
  return "an unrecognized volume entry";
}

function samePort(left: PortBinding, right: PortBinding): boolean {
  return left.service === right.service && left.target === right.target && left.protocol === right.protocol;
}

function selectPostgresDataVolume(volumes: VolumeBinding[]): VolumeBinding | undefined {
  return volumes.find((volume) => volume.target.includes("postgres")) ?? volumes[0];
}

function selectMysqlDataVolume(volumes: VolumeBinding[]): VolumeBinding | undefined {
  return volumes.find((volume) => volume.target.includes("mysql")) ?? volumes[0];
}

function withServiceArgument(
  command: string | string[] | undefined,
  prefix: string,
  argument: string,
): string | string[] {
  if (Array.isArray(command)) return [...command.filter((item) => !item.startsWith(prefix)), argument];
  if (command === undefined || command.trim() === "") return [argument];
  const pattern = new RegExp(`${escapeRegExp(prefix)}\\S*`, "g");
  return `${command.replace(pattern, "").trim()} ${argument}`.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMap(value: unknown): value is UnknownMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
