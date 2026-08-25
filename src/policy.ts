import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { BranchLiftError } from "./errors.js";
import { branchliftHome, pathExists, readJson, writeJsonAtomic } from "./paths.js";
import type { BranchLiftConfig, RepoInfo } from "./types.js";

interface TrustedPolicy {
  version: 1;
  repoKey: string;
  digest: string;
  approvedAt: string;
  sourceRoot: string;
}

export interface PolicyTrustStatus {
  digest: string;
  trusted: boolean;
  implicitDefault: boolean;
  approvedAt?: string;
  path: string;
}

export function securityPolicyDigest(config: BranchLiftConfig): string {
  const canonical = canonicalJson(config);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function policyTrustPath(repo: RepoInfo): string {
  return resolve(branchliftHome(), "trust", `${repo.key}.json`);
}

export async function inspectPolicyTrust(repo: RepoInfo, config: BranchLiftConfig): Promise<PolicyTrustStatus> {
  const digest = securityPolicyDigest(config);
  const path = policyTrustPath(repo);
  if (!(await pathExists(path))) return { digest, trusted: false, implicitDefault: false, path };
  let value: unknown;
  try {
    value = await readJson<unknown>(path);
  } catch {
    // An unreadable or malformed approval must fail closed without taking down
    // status surfaces such as the local control plane.
    return { digest, trusted: false, implicitDefault: false, path };
  }
  if (!isTrustedPolicy(value) || value.repoKey !== repo.key) return { digest, trusted: false, implicitDefault: false, path };
  return {
    digest,
    trusted: equalDigest(value.digest, digest),
    implicitDefault: false,
    approvedAt: value.approvedAt,
    path,
  };
}

export async function trustSecurityPolicy(repo: RepoInfo, config: BranchLiftConfig): Promise<PolicyTrustStatus> {
  const digest = securityPolicyDigest(config);
  const value: TrustedPolicy = {
    version: 1,
    repoKey: repo.key,
    digest,
    approvedAt: new Date().toISOString(),
    sourceRoot: repo.root,
  };
  await writeJsonAtomic(policyTrustPath(repo), value);
  return await inspectPolicyTrust(repo, config);
}

export async function revokeSecurityPolicy(repo: RepoInfo): Promise<void> {
  await rm(policyTrustPath(repo), { force: true });
}

export async function assertSecurityPolicyTrusted(repo: RepoInfo, config: BranchLiftConfig): Promise<void> {
  const status = await inspectPolicyTrust(repo, config);
  if (status.trusted) return;
  throw new BranchLiftError(
    "The project execution policy in branchlift.yaml has not been trusted on this machine.",
    `Review it, then run: branchlift security trust\nPolicy: ${status.digest}`,
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equalDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isTrustedPolicy(value: unknown): value is TrustedPolicy {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 1
    && typeof (value as Record<string, unknown>).repoKey === "string"
    && typeof (value as Record<string, unknown>).digest === "string"
    && typeof (value as Record<string, unknown>).approvedAt === "string"
    && typeof (value as Record<string, unknown>).sourceRoot === "string";
}
