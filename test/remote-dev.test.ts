import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { discoverRepo } from "../src/git.js";
import { instanceRoot, safeSlug } from "../src/paths.js";
import { securityPolicyDigest, trustSecurityPolicy } from "../src/policy.js";
import { runCommand } from "../src/process.js";
import { writeInstanceMetadata } from "../src/state.js";
import type { InstanceMetadata } from "../src/types.js";

test("remote build uses one persistent scoped BuildKit builder and cache management is explicit", async () => {
  await withRemoteWorkerFixture(async ({ root, repo, cli, env, dockerLog, commit, policyDigest }) => {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    const build = encode({
      protocol: 1,
      kind: "build",
      repoPath: root,
      context: ".",
      dockerfile: "Dockerfile",
      tag: "branchlift/test:dev",
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
      network: "none",
      noCache: false,
      cacheMax: "20gb",
    });
    const built = await runCommand(process.execPath, [cli, "build", build], { env, allowFailure: true });
    assert.equal(built.exitCode, 0, built.stderr || built.stdout);
    assert.match(built.stdout, /BRANCHLIFT-BUILD\/1/);
    let log = await readFile(dockerLog, "utf8");
    assert.match(log, /buildx version/);
    assert.match(log, /buildx inspect branchlift-/);
    assert.match(log, /buildx inspect --bootstrap branchlift-/);
    assert.match(log, /buildx build --builder branchlift-.* --load --progress=plain/);
    assert.match(log, /--network none/);
    assert.match(log, /buildx prune --builder branchlift-.* --max-used-space 20gb/);
    assert.doesNotMatch(log, /--no-cache/);

    const rebuilt = await runCommand(process.execPath, [cli, "build", build], { env, allowFailure: true });
    assert.equal(rebuilt.exitCode, 0, rebuilt.stderr || rebuilt.stdout);
    log = await readFile(dockerLog, "utf8");
    assert.equal(new Set([...log.matchAll(/buildx build --builder (branchlift-[a-f0-9]+)/g)].map((match) => match[1])).size, 1);

    const inspect = encode({
      protocol: 1,
      kind: "cache",
      repoPath: root,
      action: "inspect",
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
    });
    const inspected = await runCommand(process.execPath, [cli, "cache", inspect], { env, allowFailure: true });
    assert.equal(inspected.exitCode, 0);
    assert.match(inspected.stdout, /BRANCHLIFT-CACHE\/1/);
    log = await readFile(dockerLog, "utf8");
    assert.match(log, /buildx du --builder branchlift-/);

    const unsafePrune = encode({
      protocol: 1,
      kind: "cache",
      repoPath: root,
      action: "prune",
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
    });
    const pruned = await runCommand(process.execPath, [cli, "cache", unsafePrune], { env, allowFailure: true });
    assert.equal(pruned.exitCode, 1);
    assert.match(pruned.stderr, /exact confirmation/);

    const safePrune = encode({
      protocol: 1,
      kind: "cache",
      repoPath: root,
      action: "prune",
      confirm: "prune",
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
    });
    const safelyPruned = await runCommand(process.execPath, [cli, "cache", safePrune], { env, allowFailure: true });
    assert.equal(safelyPruned.exitCode, 0);
    assert.match(safelyPruned.stdout, /BRANCHLIFT-CACHE\/1/);
    log = await readFile(dockerLog, "utf8");
    assert.match(log, /buildx prune --builder branchlift-.* --force/);
    assert.ok(repo.root);
  });
});

test("remote agent session is forced through the least-privilege Docker sandbox", async () => {
  await withRemoteWorkerFixture(async ({ root, repo, cli, env, dockerLog, commit, policyDigest }) => {
    const branch = "agent-test";
    const slug = safeSlug(branch);
    const worktree = join(root, "worktree");
    await mkdir(worktree);
    await mkdir(instanceRoot(repo, slug), { recursive: true });
    await writeFile(join(instanceRoot(repo, slug), "context.json"), "{}\n");
    const metadata: InstanceMetadata = {
      version: 1,
      id: "agent-instance",
      branch,
      slug,
      repoKey: repo.key,
      sourceRoot: repo.root,
      worktreePath: worktree,
      snapshot: "dev",
      composeFile: "compose.yaml",
      overrideFile: join(instanceRoot(repo, slug), "compose.override.yaml"),
      volumeRoot: join(instanceRoot(repo, slug), "volumes"),
      composeProject: "branchlift-agent-test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      ports: [],
      copyStrategy: "empty",
    };
    await writeInstanceMetadata(repo, slug, metadata);
    const session = encode({
      protocol: 1,
      kind: "session",
      repoPath: root,
      branch,
      command: ["node", "agent.js"],
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
      network: "none",
      image: "branchlift-agent:test",
      writableWorktree: false,
    });
    const result = await runCommand(process.execPath, [cli, "session", session], { env, allowFailure: true });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const log = await readFile(dockerLog, "utf8");
    assert.match(log, /image inspect branchlift-agent:test/);
    assert.match(log, /run .*--cap-drop ALL/);
    assert.match(log, /--security-opt no-new-privileges/);
    assert.match(log, /--network none/);
    assert.match(log, /readonly/);
    assert.match(log, /branchlift-agent:test node agent.js/);
    assert.doesNotMatch(log, /docker\.sock/);
  });
});

test("remote development workers reject unexpected fields and escaping build paths", async () => {
  await withRemoteWorkerFixture(async ({ root, cli, env, commit, policyDigest }) => {
    const unexpectedSession = encode({
      protocol: 1,
      kind: "session",
      repoPath: root,
      branch: "agent-test",
      command: ["sh"],
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
      network: "none",
      writableWorktree: false,
      hostShell: true,
    });
    const session = await runCommand(process.execPath, [cli, "session", unexpectedSession], { env, allowFailure: true });
    assert.equal(session.exitCode, 1);
    assert.match(session.stderr, /Unexpected remote development field/);

    const escapingBuild = encode({
      protocol: 1,
      kind: "build",
      repoPath: root,
      context: "../outside",
      dockerfile: "Dockerfile",
      tag: "branchlift/test:unsafe",
      expectedCommit: commit,
      expectedPolicyDigest: policyDigest,
      network: "none",
      noCache: false,
      cacheMax: "20gb",
    });
    const build = await runCommand(process.execPath, [cli, "build", escapingBuild], { env, allowFailure: true });
    assert.equal(build.exitCode, 1);
    assert.match(build.stderr, /Remote build request is invalid/);
  });
});

test("real BuildKit builder persists across builds and supports scoped inspect/prune", {
  skip: process.env.BRANCHLIFT_E2E !== "1",
}, async () => {
  const outer = await mkdtemp(join(tmpdir(), "branchlift-buildkit-e2e-"));
  const root = join(outer, "repo");
  const state = join(outer, "state");
  const tag = `branchlift-buildkit-e2e:${process.pid}`;
  const previousHome = process.env.BRANCHLIFT_HOME;
  let builder: string | undefined;
  try {
    await mkdir(root);
    await runCommand("git", ["init", "-q"], { cwd: root });
    await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: root });
    await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: root });
    await writeFile(join(root, "compose.yaml"), "services: {}\n");
    await writeFile(join(root, "branchlift.yaml"), "version: 1\ncompose:\n  files: [compose.yaml]\n  statefulServices: []\nsnapshot:\n  default: dev\n  healthTimeoutSeconds: 120\n  seed: []\nworktree:\n  copyFiles: []\n");
    await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY hello.txt /hello.txt\n");
    await writeFile(join(root, "hello.txt"), "branchlift buildkit e2e\n");
    await runCommand("git", ["add", "."], { cwd: root });
    await runCommand("git", ["commit", "-q", "-m", "buildkit e2e"], { cwd: root });
    process.env.BRANCHLIFT_HOME = state;
    const repo = await discoverRepo(root);
    const config = await loadConfig(repo);
    await trustSecurityPolicy(repo, config);
    const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const request = encode({
      protocol: 1,
      kind: "build",
      repoPath: root,
      context: ".",
      dockerfile: "Dockerfile",
      tag,
      expectedCommit: commit,
      expectedPolicyDigest: securityPolicyDigest(config),
      network: "none",
      noCache: false,
      cacheMax: "20gb",
    });
    const first = await runCommand(process.execPath, [cli, "build", request], { allowFailure: true, maxOutputBytes: 8 * 1024 * 1024 });
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);
    const receipt = decodeReceipt(first.stdout, "BRANCHLIFT-BUILD/1 ") as { builderName?: unknown };
    assert.equal(typeof receipt.builderName, "string");
    builder = String(receipt.builderName);
    assert.match(builder, /^branchlift-[a-f0-9]{16}$/);
    assert.equal((await runCommand("docker", ["image", "inspect", tag], { allowFailure: true })).exitCode, 0);

    const second = await runCommand(process.execPath, [cli, "build", request], { allowFailure: true, maxOutputBytes: 8 * 1024 * 1024 });
    assert.equal(second.exitCode, 0, second.stderr || second.stdout);
    const cache = encode({
      protocol: 1,
      kind: "cache",
      repoPath: root,
      action: "inspect",
      expectedCommit: commit,
      expectedPolicyDigest: securityPolicyDigest(config),
    });
    const inspected = await runCommand(process.execPath, [cli, "cache", cache], { allowFailure: true, maxOutputBytes: 8 * 1024 * 1024 });
    assert.equal(inspected.exitCode, 0, inspected.stderr || inspected.stdout);
    assert.match(inspected.stdout, /BRANCHLIFT-CACHE\/1/);

    const prune = encode({
      protocol: 1,
      kind: "cache",
      repoPath: root,
      action: "prune",
      confirm: "prune",
      expectedCommit: commit,
      expectedPolicyDigest: securityPolicyDigest(config),
    });
    const pruned = await runCommand(process.execPath, [cli, "cache", prune], { allowFailure: true, maxOutputBytes: 8 * 1024 * 1024 });
    assert.equal(pruned.exitCode, 0, pruned.stderr || pruned.stdout);
  } finally {
    await runCommand("docker", ["image", "rm", "-f", tag], { allowFailure: true });
    if (builder !== undefined) await runCommand("docker", ["buildx", "rm", builder], { allowFailure: true, maxOutputBytes: 4 * 1024 * 1024 });
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    await rm(outer, { recursive: true, force: true });
  }
});

async function withRemoteWorkerFixture(
  run: (fixture: {
    root: string;
    repo: Awaited<ReturnType<typeof discoverRepo>>;
    cli: string;
    env: NodeJS.ProcessEnv;
    dockerLog: string;
    commit: string;
    policyDigest: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "branchlift-remote-dev-"));
  const state = join(root, "state");
  const bin = join(root, "bin");
  const docker = join(bin, "docker");
  const dockerLog = join(root, "docker.log");
  const previousHome = process.env.BRANCHLIFT_HOME;
  try {
    await mkdir(bin);
    await runCommand("git", ["init", "-q"], { cwd: root });
    await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: root });
    await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: root });
    await writeFile(join(root, "compose.yaml"), "services: {}\n");
    await writeFile(join(root, "branchlift.yaml"), "version: 1\ncompose:\n  files: [compose.yaml]\n  statefulServices: []\nsnapshot:\n  default: dev\n  healthTimeoutSeconds: 120\n  seed: []\nworktree:\n  copyFiles: []\nsecurity:\n  sandbox:\n    backend: docker\n    image: branchlift-agent:test\n    network: none\n    readOnlyRoot: true\n    memory: 1g\n    cpus: 1\n    pidsLimit: 64\n  allowHostAgentCommands: false\n  allowSecretCommands: false\n");
    await writeFile(docker, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BRANCHLIFT_DOCKER_LOG\"\nif [ \"${1:-}\" = buildx ] && [ \"${2:-}\" = inspect ]; then printf 'Name: branchlift-test\\nDriver: docker-container\\n'; fi\nexit 0\n", { mode: 0o700 });
    await runCommand("git", ["add", "compose.yaml", "branchlift.yaml"], { cwd: root });
    await runCommand("git", ["commit", "-q", "-m", "remote dev fixture"], { cwd: root });
    process.env.BRANCHLIFT_HOME = state;
    const repo = await discoverRepo(root);
    const config = await loadConfig(repo);
    await trustSecurityPolicy(repo, config);
    const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const env = {
      ...process.env,
      BRANCHLIFT_HOME: state,
      BRANCHLIFT_DOCKER_LOG: dockerLog,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    await run({ root, repo, cli, env, dockerLog, commit, policyDigest: securityPolicyDigest(config) });
  } finally {
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeReceipt(output: string, prefix: string): unknown {
  const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `Missing receipt ${prefix}`);
  return JSON.parse(Buffer.from(line.slice(prefix.length), "base64url").toString("utf8")) as unknown;
}
