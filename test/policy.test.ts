import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSecurityPolicyTrusted,
  inspectPolicyTrust,
  policyTrustPath,
  trustSecurityPolicy,
} from "../src/policy.js";
import { instanceRoot, pathExists, safeSlug } from "../src/paths.js";
import { execInInstance } from "../src/runtime.js";
import { writeInstanceMetadata } from "../src/state.js";
import type { BranchLiftConfig, InstanceMetadata, RepoInfo } from "../src/types.js";

test("requires an out-of-worktree digest approval for configuration-driven execution", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-policy-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  const base: BranchLiftConfig = {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: [] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles: [] },
  };
  const configured: BranchLiftConfig = {
    ...base,
    secrets: {
      api: {
        source: { env: "API_TOKEN" },
        target: { env: "API_TOKEN" },
        scopes: ["sandbox"],
        required: true,
      },
    },
  };
  try {
    assert.equal((await inspectPolicyTrust(repo, base)).trusted, false);
    assert.equal((await inspectPolicyTrust(repo, configured)).trusted, false);
    await assert.rejects(assertSecurityPolicyTrusted(repo, configured), /has not been trusted/);

    const trusted = await trustSecurityPolicy(repo, configured);
    assert.equal(trusted.trusted, true);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(policyTrustPath(repo))).mode & 0o777, 0o600);
    await assert.doesNotReject(assertSecurityPolicyTrusted(repo, configured));

    const changed: BranchLiftConfig = {
      ...configured,
      secrets: {
        ...configured.secrets,
        api: { ...configured.secrets!.api!, target: { env: "DIFFERENT_TOKEN" } },
      },
    };
    const changedStatus = await inspectPolicyTrust(repo, changed);
    assert.equal(changedStatus.trusted, false);
    assert.notEqual(changedStatus.digest, trusted.digest);
    await assert.rejects(assertSecurityPolicyTrusted(repo, changed), /has not been trusted/);

    await writeFile(policyTrustPath(repo), "{malformed", { mode: 0o600 });
    assert.equal((await inspectPolicyTrust(repo, configured)).trusted, false);
    await assert.rejects(assertSecurityPolicyTrusted(repo, configured), /has not been trusted/);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("exec requires policy approval even without exec-scoped secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-exec-policy-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repository = join(home, "repo");
  const worktree = join(home, "worktree");
  const marker = join(home, "must-not-run");
  const branch = "feature-api";
  const slug = safeSlug(branch);
  const repo: RepoInfo = { root: repository, commonDir: join(repository, ".git"), name: "demo", key: "demo-key" };
  const metadata: InstanceMetadata = {
    version: 1,
    id: "instance-id",
    branch,
    slug,
    repoKey: repo.key,
    sourceRoot: repo.root,
    worktreePath: worktree,
    snapshot: "dev",
    composeFile: "compose.yaml",
    overrideFile: join(instanceRoot(repo, slug), "compose.override.yaml"),
    volumeRoot: join(instanceRoot(repo, slug), "volumes"),
    composeProject: "branchlift-test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    ports: [],
    copyStrategy: "empty",
  };
  try {
    await mkdir(repository, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(repository, "branchlift.yaml"), "version: 1\ncompose:\n  files: [compose.yaml]\n  statefulServices: []\nsnapshot:\n  default: dev\n  healthTimeoutSeconds: 120\n  seed: []\nworktree:\n  copyFiles: []\n");
    await writeInstanceMetadata(repo, metadata.slug, metadata);
    await assert.rejects(
      execInInstance(repo, metadata.branch, [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`]),
      /has not been trusted/,
    );
    assert.equal(await pathExists(marker), false);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
