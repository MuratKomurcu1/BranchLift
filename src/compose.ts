import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { BranchLiftError } from "./errors.js";
import { pathExists, safeSlug } from "./paths.js";
import type { BindMount, ComposeInspection, PortBinding, VolumeBinding } from "./types.js";

type UnknownMap = Record<string, unknown>;

const composeCandidates = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
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

export async function inspectCompose(file: string): Promise<ComposeInspection> {
  const raw = await readFile(file, "utf8");
  const document = parse(raw) as unknown;
  if (!isMap(document)) throw new BranchLiftError(`Invalid Compose document: ${file}`);
  const serviceMap = isMap(document.services) ? document.services : undefined;
  if (serviceMap === undefined || Object.keys(serviceMap).length === 0) {
    throw new BranchLiftError(`Compose file has no services: ${file}`);
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
  const inferredStatefulServices: string[] = [];
  const postgresServices: string[] = [];

  for (const [serviceName, rawService] of Object.entries(serviceMap)) {
    if (!isMap(rawService)) {
      blockers.push(`Service ${serviceName} is not a mapping.`);
      continue;
    }
    const image = typeof rawService.image === "string" ? rawService.image : "";
    const stateful = statefulPattern.test(`/${serviceName}`) || statefulPattern.test(`/${image}`);
    if (stateful) inferredStatefulServices.push(serviceName);
    if (/(?:^|[\/_-])postgres(?:ql)?(?::|$|[\/_-])/i.test(`/${image}`)) postgresServices.push(serviceName);

    if (typeof rawService.container_name === "string") {
      blockers.push(`Service ${serviceName} sets container_name; fixed names collide across worktrees.`);
    }
    if (rawService.network_mode === "host") {
      blockers.push(`Service ${serviceName} uses host networking and cannot be port-isolated.`);
    }
    if (rawService.pid === "host" || rawService.ipc === "host") {
      warnings.push(`Service ${serviceName} shares a host namespace (${rawService.pid === "host" ? "pid" : "ipc"}).`);
    }

    const serviceVolumes = Array.isArray(rawService.volumes) ? rawService.volumes : [];
    let namedVolumeCount = 0;
    for (const rawVolume of serviceVolumes) {
      const mount = parseVolume(rawVolume, serviceName, externalVolumes);
      if (mount === undefined) continue;
      if ("external" in mount) {
        namedVolumeCount += 1;
        volumes.push(mount);
        if (mount.external) blockers.push(`Volume ${mount.source} used by ${serviceName} is external and cannot be cloned safely.`);
      } else {
        bindMounts.push(mount);
        warnings.push(`Writable bind mount ${mount.source} -> ${serviceName}:${mount.target} may leak state across worktrees.`);
      }
    }
    if (stateful && namedVolumeCount === 0) {
      blockers.push(`Stateful service ${serviceName} has no managed named volume to snapshot.`);
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
    file: resolve(file),
    services,
    inferredStatefulServices: inferredStatefulServices.sort(),
    postgresServices: postgresServices.sort(),
    volumes,
    bindMounts,
    ports,
    blockers: unique(blockers),
    warnings: unique(warnings),
  };
}

export function generateOverride(
  inspection: ComposeInspection,
  volumeRoot: string,
  options: { randomizePorts: boolean },
): string {
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
      lines.push("    volumes: !override");
      for (const volume of serviceVolumes) {
        lines.push("      - type: bind");
        lines.push(`        source: ${quote(join(volumeRoot, volumeDirectoryName(volume.source)))}`);
        lines.push(`        target: ${quote(volume.target)}`);
        if (volume.readOnly) lines.push("        read_only: true");
      }
    }
    if (inspection.postgresServices.includes(service) && serviceVolumes.length > 0) {
      const dataVolume = serviceVolumes.find((volume) => volume.target.includes("postgres")) ?? serviceVolumes[0];
      if (dataVolume !== undefined) {
        lines.push("    environment:");
        lines.push(`      PGDATA: ${quote(`${dataVolume.target}/.branchlift-pgdata`)}`);
      }
    }
    const servicePorts = portsByService.get(service) ?? [];
    if (servicePorts.length > 0) {
      lines.push("    ports: !override");
      for (const port of servicePorts) {
        lines.push(`      - target: ${port.target}`);
        lines.push(`        protocol: ${port.protocol}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
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
    if (isBindSource(source)) return { source, target, service };
    return { source, target, service, readOnly, external: externalVolumes.has(source) };
  }

  if (!isMap(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : "volume";
  const source = typeof value.source === "string" ? value.source : undefined;
  const target = typeof value.target === "string" ? value.target : undefined;
  if (source === undefined || target === undefined) return undefined;
  if (type === "bind") return { source, target, service };
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
    return { service, target, protocol: value.protocol === "udp" ? "udp" : "tcp" };
  }
  return undefined;
}

function isBindSource(source: string): boolean {
  return source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || /^[A-Za-z]:[\\/]/.test(source);
}

function samePort(left: PortBinding, right: PortBinding): boolean {
  return left.service === right.service && left.target === right.target && left.protocol === right.protocol;
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
