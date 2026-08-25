import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { volumeDirectoryName } from "../src/compose.js";
import { discoverRepo } from "../src/git.js";
import { createSnapshotManifest, writeSnapshotManifest } from "../src/manifest.js";
import { instanceRoot, makeTreeOwnerWritable, pathExists, repoDataRoot, safeSlug, snapshotRoot } from "../src/paths.js";
import { addRemote, listRemotes, remoteStorePath, removeRemote } from "../src/remote.js";
import { inspectRemoteTunnel, monitorRemoteTunnels, startRemoteTunnels, stopRemoteTunnels } from "../src/remote-dev.js";
import { pushRemoteSnapshot, syncRemoteCode, syncRemoteWorkingTree, watchRemoteWorkingTree } from "../src/remote-transfer.js";
import { runCommand } from "../src/process.js";
import { readSnapshotMetadata, writeInstanceMetadata, writeSnapshotMetadata } from "../src/state.js";
import type { InstanceMetadata, SnapshotMetadata } from "../src/types.js";

test("stores only validated SSH remote metadata in a private local file", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-remotes-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  try {
    await addRemote({ name: "buildbox", host: "dev.example.test", user: "branchlift", port: 2222, repoPath: "/srv/project" });
    const remotes = await listRemotes();
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0]?.name, "buildbox");
    assert.equal(remotes[0]?.binary, "branchlift");
    assert.equal((await stat(remoteStorePath())).mode & 0o777, 0o600);
    await assert.rejects(
      addRemote({ name: "bad", host: "-oProxyCommand=evil", repoPath: "/srv/project" }),
      /Remote host is invalid/,
    );
    await assert.rejects(
      addRemote({ name: "badidentity", host: "example.test", repoPath: "/srv/project", identityFile: "bad\nidentity" }),
      /control characters/,
    );
    await removeRemote("buildbox");
    assert.deepEqual(await listRemotes(), []);
    await writeFile(remoteStorePath(), `${JSON.stringify({
      version: 1,
      remotes: [{
        version: 1,
        name: "tampered",
        host: "example.test",
        port: 22,
        repoPath: "/srv/project",
        binary: "branchlift;touch-pwned",
        createdAt: new Date().toISOString(),
      }],
    })}\n`, { mode: 0o600 });
    await assert.rejects(listRemotes(), /unsafe worker binary/);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("worker rejects option-like start points before touching repository state", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-worker-startpoint-"));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  try {
    await runCommand("git", ["init", "-q"], { cwd: root });
    for (const startPoint of ["--force", "-b", "--config=core.fsmonitor=/tmp/evil"]) {
      const result = await runCommand(process.execPath, [cli, "worker"], {
        input: `${JSON.stringify({ protocol: 1, id: "sp-1", action: "spawn", repoPath: root, branch: "feature", startPoint })}\n`,
        allowFailure: true,
      });
      assert.equal(result.exitCode, 1);
      const frame = result.stdout.split("\n").find((line) => line.startsWith("BRANCHLIFT/1 "));
      assert.ok(frame);
      const response = JSON.parse(Buffer.from(frame.slice("BRANCHLIFT/1 ".length), "base64url").toString("utf8")) as {
        ok: boolean;
        error?: string;
      };
      assert.equal(response.ok, false);
      assert.match(response.error ?? "", /Invalid remote start point/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary receiver rejects path-like transfer identifiers before touching state", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-transfer-id-"));
  try {
    await runCommand("git", ["init", "-q"], { cwd: root });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = await runCommand(process.execPath, [cli, "receive"], {
      input: `${JSON.stringify({ protocol: 1, id: "../../escape", kind: "live-plan", repoPath: root, manifest: {} })}\n`,
      allowFailure: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /BRANCHLIFT-TRANSFER\/1/);
    assert.equal(await pathExists(join(root, "escape.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker exposes an allowlisted framed protocol instead of arbitrary remote shell execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-worker-"));
  await runCommand("git", ["init", "-q"], { cwd: root });
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const id = "request-id";
  const result = await runCommand(process.execPath, [cli, "worker"], {
    input: `${JSON.stringify({ protocol: 1, id, action: "ping", repoPath: root })}\n`,
    allowFailure: true,
  });
  assert.equal(result.exitCode, 0);
  const frame = result.stdout.split("\n").find((line) => line.startsWith("BRANCHLIFT/1 "));
  assert.ok(frame);
  const response = JSON.parse(Buffer.from(frame.slice("BRANCHLIFT/1 ".length), "base64url").toString("utf8")) as {
    id: string;
    ok: boolean;
    result: { protocol: number; repository: string };
  };
  assert.equal(response.id, id);
  assert.equal(response.ok, true);
  assert.equal(response.result.protocol, 1);
  assert.equal(response.result.repository, await realpath(root));
  await rm(root, { recursive: true, force: true });
});

test("worker binds trust to the synchronized remote commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-worker-binding-"));
  const home = join(root, "state");
  try {
    await runCommand("git", ["init", "-q"], { cwd: root });
    await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: root });
    await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: root });
    await writeFile(join(root, "branchlift.yaml"), "version: 1\ncompose:\n  files: [compose.yaml]\n  statefulServices: []\nsnapshot:\n  default: dev\n  healthTimeoutSeconds: 120\n  seed: []\nworktree:\n  copyFiles: []\n");
    await writeFile(join(root, "compose.yaml"), "services: {}\n");
    await runCommand("git", ["add", "branchlift.yaml", "compose.yaml"], { cwd: root });
    await runCommand("git", ["commit", "-q", "-m", "configured"], { cwd: root });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const id = "bound-trust";
    const result = await runCommand(process.execPath, [cli, "worker"], {
      input: `${JSON.stringify({
        protocol: 1,
        id,
        action: "trust",
        repoPath: root,
        expectedCommit: "0".repeat(40),
      })}\n`,
      env: { ...process.env, BRANCHLIFT_HOME: home },
      allowFailure: true,
    });
    assert.equal(result.exitCode, 1);
    const frame = result.stdout.split("\n").find((line) => line.startsWith("BRANCHLIFT/1 "));
    assert.ok(frame);
    const response = JSON.parse(Buffer.from(frame.slice("BRANCHLIFT/1 ".length), "base64url").toString("utf8")) as { ok: boolean; error: string };
    assert.equal(response.ok, false);
    assert.match(response.error, /checkout changed after synchronization/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code receiver verifies a Git bundle and bootstraps an exact detached checkout", async () => {
  const source = await mkdtemp(join(tmpdir(), "branchlift-sync-source-"));
  const destinationParent = await mkdtemp(join(tmpdir(), "branchlift-sync-target-"));
  const destination = join(destinationParent, "repository");
  const bundle = join(source, "code.bundle");
  try {
    await runCommand("git", ["init", "-q"], { cwd: source });
    await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: source });
    await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: source });
    await writeFile(join(source, "service.ts"), "export const ready = true;\n");
    await runCommand("git", ["add", "service.ts"], { cwd: source });
    await runCommand("git", ["commit", "-q", "-m", "initial"], { cwd: source });
    const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    await runCommand("git", ["bundle", "create", bundle, "HEAD"], { cwd: source });
    const bytes = await readFile(bundle);
    const id = "code-transfer-test";
    const header = Buffer.from(`${JSON.stringify({
      protocol: 1,
      id,
      kind: "code",
      repoPath: destination,
      commit,
      bundleBytes: bytes.length,
      bundleDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    })}\n`);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = await runCommand(process.execPath, [cli, "receive"], {
      input: Buffer.concat([header, bytes]),
      allowFailure: true,
    });
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(await readFile(join(destination, "service.ts"), "utf8"), "export const ready = true;\n");
    assert.equal((await runCommand("git", ["rev-parse", "HEAD"], { cwd: destination })).stdout.trim(), commit);
    assert.equal((await runCommand("git", ["branch", "--show-current"], { cwd: destination })).stdout.trim(), "");
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destinationParent, { recursive: true, force: true });
  }
});

test("code receiver refuses to overwrite an ignored host-only path", async () => {
  const source = await mkdtemp(join(tmpdir(), "branchlift-sync-ignored-source-"));
  const destination = await mkdtemp(join(tmpdir(), "branchlift-sync-ignored-target-"));
  const bundle = join(source, "code.bundle");
  try {
    for (const repository of [source, destination]) {
      await runCommand("git", ["init", "-q"], { cwd: repository });
      await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: repository });
      await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: repository });
      await writeFile(join(repository, ".gitignore"), ".env\n");
      await runCommand("git", ["add", ".gitignore"], { cwd: repository });
      await runCommand("git", ["commit", "-q", "-m", "ignore host environment"], { cwd: repository });
    }
    await writeFile(join(source, ".env"), "incoming=attacker-controlled\n");
    await runCommand("git", ["add", "-f", ".env"], { cwd: source });
    await runCommand("git", ["commit", "-q", "-m", "track colliding path"], { cwd: source });
    await writeFile(join(destination, ".env"), "remote=must-survive\n");
    const originalCommit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: destination })).stdout.trim();
    const commit = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    await runCommand("git", ["bundle", "create", bundle, "HEAD"], { cwd: source });
    const bytes = await readFile(bundle);
    const header = Buffer.from(`${JSON.stringify({
      protocol: 1,
      id: "ignored-conflict-test",
      kind: "code",
      repoPath: destination,
      commit,
      bundleBytes: bytes.length,
      bundleDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    })}\n`);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const result = await runCommand(process.execPath, [cli, "receive"], {
      input: Buffer.concat([header, bytes]),
      allowFailure: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /^BRANCHLIFT-TRANSFER\/1 /);
    assert.equal(await readFile(join(destination, ".env"), "utf8"), "remote=must-survive\n");
    assert.equal((await runCommand("git", ["rev-parse", "HEAD"], { cwd: destination })).stdout.trim(), originalCommit);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("snapshot receiver verifies content and reuses SHA-256 blobs across snapshot names", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-snapshot-receive-"));
  const repository = join(root, "repository");
  const sourceVolumes = join(root, "source-volumes");
  const remoteHome = join(root, "remote-home");
  const volume = "database";
  const volumePath = join(sourceVolumes, volumeDirectoryName(volume));
  const payload = Buffer.from("durable-state\n");
  const previousHome = process.env.BRANCHLIFT_HOME;
  try {
    await mkdir(repository);
    await runCommand("git", ["init", "-q"], { cwd: repository });
    await mkdir(volumePath, { recursive: true });
    await writeFile(join(volumePath, "state.bin"), payload);
    await chmod(join(volumePath, "state.bin"), 0o444);
    const manifest = await createSnapshotManifest("golden", sourceVolumes, [volume]);
    const entry = manifest.entries.find((candidate) => candidate.kind === "file");
    assert.ok(entry);
    const metadata = snapshotTransferMetadata("golden", repository, volume, manifest.digest, manifest.entries.length, payload.length);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const first = await runCommand(process.execPath, [cli, "receive"], {
      input: snapshotTransferInput(repository, "first-transfer", manifest, metadata, [entry.digest], payload),
      env: { ...process.env, BRANCHLIFT_HOME: remoteHome },
      allowFailure: true,
    });
    assert.equal(first.exitCode, 0, first.stderr || first.stdout);

    const secondManifest = { ...manifest, snapshot: "derived" };
    const secondMetadata = snapshotTransferMetadata("derived", repository, volume, manifest.digest, manifest.entries.length, payload.length);
    const second = await runCommand(process.execPath, [cli, "receive"], {
      input: snapshotTransferInput(repository, "second-transfer", secondManifest, secondMetadata, [], Buffer.alloc(0)),
      env: { ...process.env, BRANCHLIFT_HOME: remoteHome },
      allowFailure: true,
    });
    assert.equal(second.exitCode, 0, second.stderr || second.stdout);

    process.env.BRANCHLIFT_HOME = remoteHome;
    const repo = await discoverRepo(repository);
    assert.equal(await readFile(join(snapshotRoot(repo, "golden"), "volumes", volumeDirectoryName(volume), "state.bin"), "utf8"), "durable-state\n");
    assert.equal((await stat(join(snapshotRoot(repo, "golden"), "volumes", volumeDirectoryName(volume), "state.bin"))).mode & 0o222, 0);
    assert.equal((await readSnapshotMetadata(repo, "derived")).contentDigest, manifest.digest);

    const published = join(snapshotRoot(repo, "golden"), "volumes", volumeDirectoryName(volume), "state.bin");
    await chmod(published, 0o600);
    await writeFile(published, "corrupted-state\n");
    const duplicate = await runCommand(process.execPath, [cli, "receive"], {
      input: snapshotTransferInput(repository, "duplicate-corruption-test", manifest, metadata, [], Buffer.alloc(0)),
      env: { ...process.env, BRANCHLIFT_HOME: remoteHome },
      allowFailure: true,
    });
    assert.equal(duplicate.exitCode, 1);
    assert.match(duplicate.stdout, /^BRANCHLIFT-TRANSFER\/1 /);
    await writeFile(published, payload);
    await chmod(published, 0o444);

    const blob = join(repoDataRoot(repo), "blobs", "sha256", entry.digest.slice("sha256:".length));
    await chmod(blob, 0o600);
    await writeFile(blob, Buffer.alloc(payload.length, 0x78));
    const corruptManifest = { ...manifest, snapshot: "corruption-check" };
    const corruptMetadata = snapshotTransferMetadata("corruption-check", repository, volume, manifest.digest, manifest.entries.length, payload.length);
    const corrupt = await runCommand(process.execPath, [cli, "receive"], {
      input: snapshotTransferInput(repository, "corruption-transfer", corruptManifest, corruptMetadata, [], Buffer.alloc(0)),
      env: { ...process.env, BRANCHLIFT_HOME: remoteHome },
      allowFailure: true,
    });
    assert.equal(corrupt.exitCode, 1);
    assert.match(corrupt.stdout, /BRANCHLIFT-TRANSFER\/1/);
    assert.equal(await pathExists(blob), false);
    assert.equal(await pathExists(snapshotRoot(repo, "corruption-check")), false);
  } finally {
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    if (await pathExists(remoteHome)) await makeTreeOwnerWritable(remoteHome);
    await rm(root, { recursive: true, force: true });
  }
});

test("sender and receiver complete code plus snapshot sync through the SSH command boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-remote-e2e-"));
  const sourcePath = join(root, "source");
  const remotePath = join(root, "remote-repository");
  const stateHome = join(root, "state");
  const binPath = join(root, "bin");
  const fakeSsh = join(binPath, "ssh");
  const remoteBinary = join(binPath, "remote-branchlift");
  const previousHome = process.env.BRANCHLIFT_HOME;
  const previousPath = process.env.PATH;
  try {
    await mkdir(sourcePath);
    await mkdir(binPath);
    await runCommand("git", ["init", "-q"], { cwd: sourcePath });
    await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: sourcePath });
    await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: sourcePath });
    await writeFile(join(sourcePath, "backend.ts"), "export const remote = 'ready';\n");
    await runCommand("git", ["add", "backend.ts"], { cwd: sourcePath });
    await runCommand("git", ["commit", "-q", "-m", "remote sync"], { cwd: sourcePath });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await writeFile(fakeSsh, "#!/bin/sh\nwhile [ \"$#\" -gt 0 ] && [ \"$1\" != \"--\" ]; do shift; done\n[ \"$1\" = \"--\" ] && shift\nshift\nexec \"$@\"\n", { mode: 0o700 });
    await writeFile(remoteBinary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} \"$@\"\n`, { mode: 0o700 });
    process.env.BRANCHLIFT_HOME = stateHome;
    process.env.PATH = `${binPath}:${previousPath ?? ""}`;
    const repo = await discoverRepo(sourcePath);
    await addRemote({ name: "localtest", host: "example.test", repoPath: remotePath, binary: remoteBinary });

    const snapshotPath = snapshotRoot(repo, "dev");
    const volume = "database";
    const volumePath = join(snapshotPath, "volumes", volumeDirectoryName(volume));
    await mkdir(volumePath, { recursive: true });
    await writeFile(join(volumePath, "state.txt"), "seeded\n");
    await chmod(join(volumePath, "state.txt"), 0o444);
    const manifest = await createSnapshotManifest("dev", join(snapshotPath, "volumes"), [volume]);
    await writeSnapshotManifest(snapshotPath, manifest);
    await writeSnapshotMetadata(repo, "dev", snapshotTransferMetadata("dev", repo.root, volume, manifest.digest, manifest.entries.length, 7));

    const code = await syncRemoteCode(repo, "localtest");
    const state = await pushRemoteSnapshot(repo, "localtest", "dev");
    assert.equal(code.dirtyPathsExcluded, 0);
    assert.equal(state.transferredBlobs, 1);
    assert.equal(await readFile(join(remotePath, "backend.ts"), "utf8"), "export const remote = 'ready';\n");
    const remoteRepo = await discoverRepo(remotePath);
    const remoteState = join(snapshotRoot(remoteRepo, "dev"), "volumes", volumeDirectoryName(volume), "state.txt");
    assert.equal(await readFile(remoteState, "utf8"), "seeded\n");
    await chmod(remoteState, 0o600);
    await writeFile(remoteState, "tamper\n");
    await assert.rejects(pushRemoteSnapshot(repo, "localtest", "dev"), /rejected snapshot-plan/);
  } finally {
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (await pathExists(stateHome)) await makeTreeOwnerWritable(stateHome);
    await rm(root, { recursive: true, force: true });
  }
});

test("live sync mirrors safe working changes, deletes managed files, and refuses remote conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-live-sync-e2e-"));
  const sourcePath = join(root, "source");
  const remotePath = join(root, "remote");
  const worktreePath = join(root, "remote-worktree");
  const stateHome = join(root, "state");
  const binPath = join(root, "bin");
  const fakeSsh = join(binPath, "ssh");
  const remoteBinary = join(binPath, "remote-branchlift");
  const previousHome = process.env.BRANCHLIFT_HOME;
  const previousPath = process.env.PATH;
  try {
    await mkdir(sourcePath);
    await mkdir(binPath);
    await runCommand("git", ["init", "-q"], { cwd: sourcePath });
    await runCommand("git", ["config", "user.name", "BranchLift Test"], { cwd: sourcePath });
    await runCommand("git", ["config", "user.email", "branchlift@example.test"], { cwd: sourcePath });
    await writeFile(join(sourcePath, ".gitignore"), "secret.env\n");
    await writeFile(join(sourcePath, "app.ts"), "export const version = 1;\n");
    await runCommand("git", ["add", ".gitignore", "app.ts"], { cwd: sourcePath });
    await runCommand("git", ["commit", "-q", "-m", "live base"], { cwd: sourcePath });
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await writeFile(fakeSsh, "#!/bin/sh\nwhile [ \"$#\" -gt 0 ] && [ \"$1\" != \"--\" ]; do shift; done\n[ \"$1\" = \"--\" ] && shift\n[ \"$#\" -gt 0 ] && shift\n[ \"$#\" -eq 0 ] && exit 0\nexec \"$@\"\n", { mode: 0o700 });
    await writeFile(remoteBinary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o700 });
    process.env.BRANCHLIFT_HOME = stateHome;
    process.env.PATH = `${binPath}:${previousPath ?? ""}`;
    const localRepo = await discoverRepo(sourcePath);
    await addRemote({ name: "livebox", host: "example.test", repoPath: remotePath, binary: remoteBinary });
    const code = await syncRemoteCode(localRepo, "livebox");
    await runCommand("git", ["worktree", "add", "-q", "-b", "live-test", worktreePath, code.commit], { cwd: remotePath });
    const remoteRepo = await discoverRepo(remotePath);
    const slug = safeSlug("live-test");
    const metadata: InstanceMetadata = {
      version: 1,
      id: "live-instance",
      branch: "live-test",
      slug,
      repoKey: remoteRepo.key,
      sourceRoot: remoteRepo.root,
      worktreePath,
      worktreeOwner: "branchlift",
      snapshot: "dev",
      composeFile: "compose.yaml",
      overrideFile: join(instanceRoot(remoteRepo, slug), "compose.override.yaml"),
      volumeRoot: join(instanceRoot(remoteRepo, slug), "volumes"),
      composeProject: "branchlift-live-test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      ports: [
        { service: "api", target: 3000, protocol: "tcp", host: "127.0.0.1", port: 43000 },
        { service: "metrics", target: 9090, protocol: "tcp", host: "127.0.0.1", port: 43001 },
        { service: "dns", target: 5353, protocol: "udp", host: "127.0.0.1", port: 43002 },
      ],
      copyStrategy: "empty",
    };
    await writeInstanceMetadata(remoteRepo, slug, metadata);

    await writeFile(join(sourcePath, "app.ts"), "export const version = 2;\n");
    await writeFile(join(sourcePath, "notes.txt"), "untracked but intentional\n");
    await writeFile(join(sourcePath, "secret.env"), "must-not-sync\n");
    const first = await syncRemoteWorkingTree(localRepo, "livebox", "live-test");
    assert.equal(first.transferredFiles, 2);
    assert.equal(await readFile(join(worktreePath, "app.ts"), "utf8"), "export const version = 2;\n");
    assert.equal(await readFile(join(worktreePath, "notes.txt"), "utf8"), "untracked but intentional\n");
    assert.equal(await pathExists(join(worktreePath, "secret.env")), false);

    await rm(join(sourcePath, "notes.txt"));
    const second = await syncRemoteWorkingTree(localRepo, "livebox", "live-test");
    assert.equal(second.deletedFiles, 1);
    assert.equal(await pathExists(join(worktreePath, "notes.txt")), false);

    const watchController = new AbortController();
    let watchCallbacks = 0;
    const watchTimeout = setTimeout(() => watchController.abort(), 3_000);
    await watchRemoteWorkingTree(localRepo, "livebox", "live-test", {
      intervalMs: 250,
      signal: watchController.signal,
      onSync: () => {
        watchCallbacks += 1;
        if (watchCallbacks === 1) {
          setTimeout(() => void writeFile(join(sourcePath, "app.ts"), "export const version = 2.5;\n"), 600);
        } else watchController.abort();
      },
    });
    clearTimeout(watchTimeout);
    assert.equal(watchCallbacks, 2);
    assert.equal(await readFile(join(worktreePath, "app.ts"), "utf8"), "export const version = 2.5;\n");

    const tunnel = await startRemoteTunnels(localRepo, "livebox", "live-test");
    assert.equal(tunnel.mappings.length, 2);
    assert.equal(tunnel.mappings[0]?.remotePort, 43000);
    assert.deepEqual(new Set(tunnel.mappings.map((mapping) => mapping.localPort)).size, 2);
    assert.ok(tunnel.mappings.every((mapping) => mapping.localHost === "127.0.0.1" && mapping.remoteHost === "127.0.0.1"));
    assert.ok(await inspectRemoteTunnel(localRepo, "livebox", "live-test"));
    const controller = new AbortController();
    let recovered = 0;
    let recoveredTunnel: Awaited<ReturnType<typeof startRemoteTunnels>> | undefined;
    const emergencyStop = setTimeout(() => controller.abort(), 2_000);
    await monitorRemoteTunnels(localRepo, "livebox", "live-test", {
      intervalMs: 250,
      signal: controller.signal,
      onRestart: (state) => {
        recovered += 1;
        recoveredTunnel = state;
        controller.abort();
      },
    });
    clearTimeout(emergencyStop);
    assert.equal(recovered, 1);
    assert.deepEqual(recoveredTunnel?.mappings.map((mapping) => mapping.localPort), tunnel.mappings.map((mapping) => mapping.localPort));
    assert.equal(await stopRemoteTunnels(localRepo, "livebox", "live-test"), true);

    await writeFile(join(worktreePath, "app.ts"), "remote agent edit\n");
    await writeFile(join(sourcePath, "app.ts"), "export const version = 3;\n");
    await assert.rejects(syncRemoteWorkingTree(localRepo, "livebox", "live-test"), /rejected the transfer/);
  } finally {
    if (previousHome === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

function snapshotTransferMetadata(
  name: string,
  repository: string,
  volume: string,
  digest: string,
  fileCount: number,
  sizeBytes: number,
): SnapshotMetadata {
  return {
    version: 1,
    name,
    repoKey: "source",
    sourceRoot: repository,
    composeFile: "compose.yaml",
    composeFiles: ["compose.yaml"],
    composeProject: "source",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "ready",
    volumeNames: [volume],
    sizeBytes,
    contentDigest: digest,
    manifestFile: "manifest.json",
    fileCount,
  };
}

function snapshotTransferInput(
  repository: string,
  id: string,
  manifest: Awaited<ReturnType<typeof createSnapshotManifest>>,
  metadata: SnapshotMetadata,
  sentDigests: string[],
  payload: Buffer,
): Buffer {
  const header = Buffer.from(`${JSON.stringify({
    protocol: 1,
    id,
    kind: "snapshot",
    repoPath: repository,
    snapshot: manifest.snapshot,
    manifest,
    metadata,
    sentDigests,
    symlinks: [],
  })}\n`);
  if (sentDigests.length === 0) return header;
  const frame = Buffer.from(`${JSON.stringify({ digest: sentDigests[0], size: payload.length })}\n`);
  return Buffer.concat([header, frame, payload]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
