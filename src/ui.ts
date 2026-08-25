import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { effectiveUi, inspectConfiguredCompose, loadConfig } from "./config.js";
import { BranchLiftError } from "./errors.js";
import { listEvents } from "./events.js";
import { diffSnapshots } from "./manifest.js";
import { previewInstances, readInstanceLogs } from "./preview.js";
import { inspectPolicyTrust, securityPolicyDigest } from "./policy.js";
import { runCommand } from "./process.js";
import { addRemote, callRemote, listRemotes, removeRemote, setupRemote } from "./remote.js";
import { inspectRemoteTunnel, runRemoteBuildCaptured, runRemoteCacheCaptured, startRemoteTunnels, stopRemoteTunnels } from "./remote-dev.js";
import { pushRemoteSnapshot, syncRemoteCode, syncRemoteWorkingTree } from "./remote-transfer.js";
import { destroyInstance, resetInstance, spawnInstance, startInstance, stopInstance } from "./runtime.js";
import { sandboxPosture } from "./sandbox.js";
import { inspectSecrets } from "./secrets.js";
import { commitSnapshotFromInstance } from "./snapshot.js";
import { listSnapshots } from "./state.js";
import type { BranchLiftConfig, RepoInfo } from "./types.js";
import { version } from "./version.js";

const maximumBodyBytes = 64 * 1024;

export interface UiServerOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  token?: string;
}

export interface UiServerHandle {
  server: Server;
  host: string;
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
}

interface UiRuntime {
  repo: RepoInfo;
  config: BranchLiftConfig;
  token: string;
  origin: string;
}

export async function startUiServer(
  repo: RepoInfo,
  config: BranchLiftConfig,
  options: UiServerOptions = {},
): Promise<UiServerHandle> {
  const defaults = effectiveUi(config);
  const host = options.host ?? defaults.host;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new BranchLiftError("The BranchLift UI may only listen on 127.0.0.1 or ::1.");
  }
  const port = options.port ?? defaults.port;
  const token = options.token ?? randomBytes(32).toString("base64url");
  assertUiToken(token);
  const runtime: UiRuntime = { repo, config, token, origin: "" };
  const server = createServer((request, response) => {
    void handleRequest(runtime, request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, error instanceof BranchLiftError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BranchLiftError(`Unable to start the BranchLift UI on ${host}:${port}.`, detail);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null || typeof address.port !== "number") {
    server.close();
    throw new BranchLiftError("Unable to determine the BranchLift UI address.");
  }
  const displayHost = host === "::1" ? "[::1]" : host;
  runtime.origin = `http://${displayHost}:${address.port}`;
  const url = `${runtime.origin}/#${token}`;
  return {
    server,
    host,
    port: address.port,
    token,
    url,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export async function runUiServer(
  repo: RepoInfo,
  config: BranchLiftConfig,
  options: UiServerOptions & { open?: boolean } = {},
): Promise<void> {
  const handle = await startUiServer(repo, config, options);
  console.log(`BranchLift control plane: ${handle.url}`);
  console.log("The session token is kept in the URL fragment and is never sent in HTTP logs.");
  if (options.open !== false) await openBrowserBestEffort(handle.url);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void handle.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function handleRequest(runtime: UiRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  setSecurityHeaders(response);
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", runtime.origin || "http://127.0.0.1");
  if (method === "GET" && url.pathname === "/") return sendText(response, 200, "text/html; charset=utf-8", html);
  if (method === "GET" && url.pathname === "/app.css") return sendText(response, 200, "text/css; charset=utf-8", css);
  if (method === "GET" && url.pathname === "/app.js") return sendText(response, 200, "text/javascript; charset=utf-8", javascript);
  if (!url.pathname.startsWith("/api/")) return sendJson(response, 404, { error: "Not found" });
  if (!authorized(runtime, request)) return sendJson(response, 401, { error: "Unauthorized" });
  if (!sameOrigin(runtime, request)) return sendJson(response, 403, { error: "Origin rejected" });

  if (method === "GET" && url.pathname === "/api/state") {
    const currentConfig = await loadConfig(runtime.repo).catch(() => runtime.config);
    return sendJson(response, 200, await dashboardState(runtime.repo, currentConfig));
  }
  if (method === "GET" && url.pathname === "/api/logs") {
    const branch = requiredQuery(url, "branch");
    const service = url.searchParams.get("service") ?? undefined;
    const tailValue = url.searchParams.get("tail") ?? "200";
    const tail = Number.parseInt(tailValue, 10);
    if (!Number.isInteger(tail) || tail < 1 || tail > 2000) return sendJson(response, 400, { error: "Invalid tail" });
    const logs = await readInstanceLogs(runtime.repo, branch, {
      ...(service === undefined || service === "" ? {} : { service }),
      tail,
      follow: false,
      timestamps: true,
    });
    return sendJson(response, 200, { branch, service: service ?? null, logs });
  }
  if (method === "GET" && url.pathname === "/api/events/stream") {
    return await streamEvents(runtime.repo, request, response);
  }
  if (method === "POST" && url.pathname.startsWith("/api/actions/")) {
    const action = url.pathname.slice("/api/actions/".length);
    const body = await readJsonBody(request);
    if (action === "remote-add") {
      const port = body.port === undefined || body.port === "" ? undefined : numberField(body, "port");
      const remote = await addRemote({
        name: stringField(body, "name"),
        host: stringField(body, "host"),
        repoPath: stringField(body, "repoPath"),
        ...(typeof body.user === "string" && body.user !== "" ? { user: body.user } : {}),
        ...(port === undefined ? {} : { port }),
        ...(typeof body.identityFile === "string" && body.identityFile !== "" ? { identityFile: body.identityFile } : {}),
        ...(typeof body.binary === "string" && body.binary !== "" ? { binary: body.binary } : {}),
      });
      return sendJson(response, 200, { ok: true, remote });
    }
    if (action === "remote-ping") {
      const name = stringField(body, "name");
      const startedAt = performance.now();
      const result = await callRemote(runtime.repo, name, { action: "ping" });
      return sendJson(response, 200, { ok: true, result, latencyMs: Math.round(performance.now() - startedAt) });
    }
    if (action === "remote-setup") {
      const name = stringField(body, "name");
      return sendJson(response, 200, { ok: true, remote: await setupRemote(runtime.repo, name) });
    }
    if (action === "remote-remove") {
      const name = stringField(body, "name");
      if (body.confirm !== name) return sendJson(response, 400, { error: "Remote removal confirmation must match the name." });
      await removeRemote(name);
      return sendJson(response, 200, { ok: true });
    }
    if (action === "remote-operate") {
      const name = stringField(body, "name");
      const operation = stringField(body, "operation");
      if (operation === "sync") {
        const config = await loadConfig(runtime.repo);
        const snapshot = typeof body.snapshot === "string" && body.snapshot !== "" ? body.snapshot : config.snapshot.default;
        await ensureUiRemoteReady(runtime.repo, name);
        const code = await syncRemoteCode(runtime.repo, name);
        const state = await pushRemoteSnapshot(runtime.repo, name, snapshot);
        return sendJson(response, 200, { ok: true, result: { remote: name, code, state } });
      }
      if (operation === "launch") {
        const config = await loadConfig(runtime.repo);
        const branch = stringField(body, "branch");
        const snapshot = typeof body.snapshot === "string" && body.snapshot !== "" ? body.snapshot : config.snapshot.default;
        const start = body.start === undefined ? true : booleanField(body, "start");
        const trustPolicy = body.trustPolicy === undefined ? false : booleanField(body, "trustPolicy");
        await ensureUiRemoteReady(runtime.repo, name);
        const code = await syncRemoteCode(runtime.repo, name);
        const state = await pushRemoteSnapshot(runtime.repo, name, snapshot);
        const expectedPolicyDigest = securityPolicyDigest(config);
        if (trustPolicy) await callRemote(runtime.repo, name, {
          action: "trust",
          expectedCommit: code.commit,
          expectedPolicyDigest,
        });
        const instance = await callRemote(runtime.repo, name, {
          action: "spawn",
          branch,
          snapshot,
          start,
          startPoint: code.commit,
          expectedCommit: code.commit,
          expectedPolicyDigest,
        });
        return sendJson(response, 200, { ok: true, result: { remote: name, code, state, policyTrusted: trustPolicy, instance } });
      }
      if (operation === "live-sync") {
        const branch = stringField(body, "branch");
        await ensureUiRemoteReady(runtime.repo, name);
        return sendJson(response, 200, { ok: true, result: await syncRemoteWorkingTree(runtime.repo, name, branch) });
      }
      if (operation === "tunnel-start" || operation === "tunnel-status" || operation === "tunnel-stop") {
        const branch = stringField(body, "branch");
        if (operation === "tunnel-start") {
          await ensureUiRemoteReady(runtime.repo, name);
          return sendJson(response, 200, { ok: true, result: await startRemoteTunnels(runtime.repo, name, branch) });
        }
        if (operation === "tunnel-status") {
          return sendJson(response, 200, { ok: true, result: await inspectRemoteTunnel(runtime.repo, name, branch) ?? null });
        }
        return sendJson(response, 200, { ok: true, result: { stopped: await stopRemoteTunnels(runtime.repo, name, branch) } });
      }
      if (operation === "build") {
        const tag = stringField(body, "tag");
        const branch = typeof body.branch === "string" && body.branch !== "" ? body.branch : undefined;
        const context = typeof body.context === "string" && body.context !== "" ? body.context : undefined;
        const dockerfile = typeof body.dockerfile === "string" && body.dockerfile !== "" ? body.dockerfile : undefined;
        const cacheMax = typeof body.cacheMax === "string" && body.cacheMax !== "" ? body.cacheMax : undefined;
        const network = body.network === undefined || body.network === "" ? "default" : stringField(body, "network");
        if (network !== "default" && network !== "none") return sendJson(response, 400, { error: "Build network must be default or none." });
        await ensureUiRemoteReady(runtime.repo, name);
        const result = await runRemoteBuildCaptured(runtime.repo, name, {
          tag,
          ...(branch === undefined ? {} : { branch }),
          ...(context === undefined ? {} : { context }),
          ...(dockerfile === undefined ? {} : { dockerfile }),
          network,
          noCache: body.noCache === undefined ? false : booleanField(body, "noCache"),
          ...(cacheMax === undefined ? {} : { cacheMax }),
        });
        return sendJson(response, 200, { ok: result.exitCode === 0, result });
      }
      if (operation === "cache-inspect" || operation === "cache-prune") {
        const action = operation === "cache-prune" ? "prune" : "inspect";
        if (action === "prune" && body.confirm !== "prune") return sendJson(response, 400, { error: "Cache prune requires exact confirmation." });
        await ensureUiRemoteReady(runtime.repo, name);
        const result = await runRemoteCacheCaptured(runtime.repo, name, action, action === "prune" ? "prune" : undefined);
        return sendJson(response, 200, { ok: result.exitCode === 0, result });
      }
      if (operation === "trust") {
        return sendJson(response, 200, { ok: true, result: await callRemote(runtime.repo, name, { action: "trust" }) });
      }
      if (operation === "ping" || operation === "list" || operation === "snapshots") {
        return sendJson(response, 200, { ok: true, result: await callRemote(runtime.repo, name, { action: operation }) });
      }
      if (operation === "preview") {
        const branch = typeof body.branch === "string" && body.branch !== "" ? body.branch : undefined;
        return sendJson(response, 200, {
          ok: true,
          result: await callRemote(runtime.repo, name, { action: "preview", ...(branch === undefined ? {} : { branch }) }),
        });
      }
      const branch = stringField(body, "branch");
      if (operation === "spawn") {
        const snapshot = typeof body.snapshot === "string" && body.snapshot !== "" ? body.snapshot : undefined;
        const start = body.start === undefined ? true : booleanField(body, "start");
        return sendJson(response, 200, {
          ok: true,
          result: await callRemote(runtime.repo, name, {
            action: "spawn",
            branch,
            start,
            ...(snapshot === undefined ? {} : { snapshot }),
          }),
        });
      }
      if (operation === "start" || operation === "stop") {
        return sendJson(response, 200, { ok: true, result: await callRemote(runtime.repo, name, { action: operation, branch }) });
      }
      if (operation === "reset" || operation === "destroy") {
        if (body.confirm !== branch) return sendJson(response, 400, { error: `${operation} confirmation must match the branch.` });
        return sendJson(response, 200, {
          ok: true,
          result: await callRemote(runtime.repo, name, {
            action: operation,
            branch,
            confirm: branch,
            ...(operation === "reset" ? { start: body.start === undefined ? true : booleanField(body, "start") } : {}),
          }),
        });
      }
      return sendJson(response, 400, { error: "Unsupported remote operation" });
    }
    const currentConfig = await loadConfig(runtime.repo);
    if (action === "snapshot-diff") {
      return sendJson(response, 200, {
        ok: true,
        diff: await diffSnapshots(runtime.repo, stringField(body, "left"), stringField(body, "right")),
      });
    }
    if (action === "snapshot-commit") {
      const inspection = await inspectConfiguredCompose(runtime.repo, currentConfig);
      const name = stringField(body, "name");
      const branch = stringField(body, "branch");
      const result = await commitSnapshotFromInstance(runtime.repo, currentConfig, inspection, name, branch);
      return sendJson(response, 200, { ok: true, snapshot: result.metadata });
    }
    const branch = stringField(body, "branch");
    if (action === "spawn") {
      const inspection = await inspectConfiguredCompose(runtime.repo, currentConfig);
      const snapshot = typeof body.snapshot === "string" && body.snapshot !== "" ? body.snapshot : currentConfig.snapshot.default;
      const start = body.start === undefined ? true : booleanField(body, "start");
      const instance = await spawnInstance(runtime.repo, currentConfig, inspection, branch, {
        snapshot,
        start,
        agentCommand: [],
        quiet: true,
      });
      return sendJson(response, 200, { ok: true, instance });
    }
    if (action === "start") {
      const inspection = await inspectConfiguredCompose(runtime.repo, currentConfig);
      const instance = await startInstance(runtime.repo, currentConfig, inspection, branch, { agentCommand: [], quiet: true });
      return sendJson(response, 200, { ok: true, instance });
    }
    if (action === "stop") {
      return sendJson(response, 200, { ok: true, instance: await stopInstance(runtime.repo, branch) });
    }
    if (action === "reset") {
      if (body.confirm !== branch) return sendJson(response, 400, { error: "Reset confirmation must match the branch." });
      const inspection = await inspectConfiguredCompose(runtime.repo, currentConfig);
      const instance = await resetInstance(runtime.repo, currentConfig, inspection, branch, true);
      return sendJson(response, 200, { ok: true, instance });
    }
    if (action === "destroy") {
      if (body.confirm !== branch) return sendJson(response, 400, { error: "Destroy confirmation must match the branch." });
      const result = await destroyInstance(runtime.repo, branch, false);
      return sendJson(response, 200, { ok: true, result });
    }
    return sendJson(response, 404, { error: "Unknown action" });
  }
  return sendJson(response, 404, { error: "Not found" });
}

async function dashboardState(repo: RepoInfo, config: BranchLiftConfig): Promise<Record<string, unknown>> {
  const [instances, snapshots, events, secrets, remotes, policy] = await Promise.all([
    previewInstances(repo),
    listSnapshots(repo),
    listEvents(repo, 100),
    inspectSecrets(repo, config),
    listRemotes(),
    inspectPolicyTrust(repo, config),
  ]);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repository: { name: repo.name, root: repo.root },
    instances,
    snapshots,
    events,
    secrets,
    remotes: remotes.map((remote) => ({
      name: remote.name,
      host: remote.host,
      user: remote.user ?? null,
      port: remote.port,
      repoPath: remote.repoPath,
      binary: remote.binary,
      managedBinary: remote.managedBinary ?? false,
      lastSetupAt: remote.lastSetupAt ?? null,
      identityConfigured: remote.identityFile !== undefined,
    })),
    security: sandboxPosture(config),
    policy,
  };
}

async function ensureUiRemoteReady(repo: RepoInfo, name: string): Promise<void> {
  try {
    const result = await callRemote(repo, name, { action: "ping" });
    if (typeof result === "object" && result !== null && "version" in result && result.version === version) return;
  } catch {
    // Installing below yields the actionable SSH or package error.
  }
  await setupRemote(repo, name);
}

async function streamEvents(repo: RepoInfo, request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  let known = new Set<string>();
  const send = async () => {
    const events = (await listEvents(repo, 200)).reverse();
    if (known.size === 0) known = new Set(events.map(({ id }) => id));
    else {
      for (const event of events) {
        if (known.has(event.id)) continue;
        known.add(event.id);
        response.write(`event: branchlift\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }
    response.write(": heartbeat\n\n");
  };
  await send();
  const interval = setInterval(() => void send().catch(() => response.end()), 1500);
  interval.unref();
  await new Promise<void>((resolve) => {
    response.once("close", () => {
      clearInterval(interval);
      resolve();
    });
    request.once("aborted", () => {
      clearInterval(interval);
      resolve();
    });
  });
}

function authorized(runtime: UiRuntime, request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (header === undefined || Array.isArray(header) || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(runtime.token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sameOrigin(runtime: UiRuntime, request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === runtime.origin;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new BranchLiftError("Expected application/json.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > maximumBodyBytes) throw new BranchLiftError("Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BranchLiftError("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "" || field.length > 300) {
    throw new BranchLiftError(`${key} must be a non-empty string no longer than 300 characters.`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  const parsed = typeof field === "number" ? field : typeof field === "string" ? Number.parseInt(field, 10) : Number.NaN;
  if (!Number.isInteger(parsed)) throw new BranchLiftError(`${key} must be an integer.`);
  return parsed;
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new BranchLiftError(`${key} must be a boolean.`);
  return field;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === "" || value.length > 300) throw new BranchLiftError(`Missing or invalid ${name}.`);
  return value;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function assertUiToken(value: string): void {
  if (value.length < 32 || value.length > 256 || /\s/.test(value)) throw new BranchLiftError("UI session token is invalid.");
}

async function openBrowserBestEffort(url: string): Promise<void> {
  if (process.platform === "darwin") await runCommand("open", [url], { allowFailure: true });
  else if (process.platform === "linux") await runCommand("xdg-open", [url], { allowFailure: true });
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BranchLift Control Plane</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <header>
    <div class="brand"><span class="mark">BL</span><div><strong>BranchLift</strong><small>Local control plane</small></div></div>
    <div class="header-right"><span id="connection" class="pill warning">Connecting</span><button id="refresh" class="ghost">Refresh</button></div>
  </header>
  <main>
    <section id="locked" class="locked hidden"><h1>Session token required</h1><p>Open the exact URL printed by <code>branchlift ui</code>.</p></section>
    <div id="app" class="hidden">
      <section class="hero"><div><p class="eyebrow">STATEFUL DEVELOPMENT ENVIRONMENTS</p><h1 id="repo-name">Repository</h1><p id="repo-root" class="muted"></p></div><div id="generated" class="muted"></div></section>
      <section id="stats" class="stats"></section>
      <section class="grid wide-left">
        <article class="panel"><div class="panel-head"><div><p class="eyebrow">RUNTIMES</p><h2>Branch environments</h2></div></div><input id="instance-filter" class="filter-input" type="search" placeholder="Filter environments (press /)" autocomplete="off"><div id="instances" class="instance-list"></div><details><summary>Spawn environment</summary><form id="spawn-form" class="control-form"><input name="branch" placeholder="feature/branch" required><input name="snapshot" placeholder="snapshot (default)"><label><input name="start" type="checkbox" checked> Start now</label><button class="action" type="submit">Spawn</button></form></details></article>
        <article class="panel"><div class="panel-head"><div><p class="eyebrow">SECURITY</p><h2>Effective posture</h2></div></div><div id="security"></div><div id="secrets"></div></article>
      </section>
      <section class="grid">
        <article class="panel"><div class="panel-head"><div><p class="eyebrow">DATA PLANE</p><h2>Immutable snapshots</h2></div></div><input id="snapshot-filter" class="filter-input" type="search" placeholder="Filter snapshots" autocomplete="off"><div id="snapshots"></div><details><summary>Commit or compare state</summary><form id="commit-form" class="control-form"><input name="name" placeholder="new snapshot" required><input name="branch" placeholder="source branch" required><button class="action" type="submit">Commit state</button></form><form id="diff-form" class="control-form"><input name="left" placeholder="base snapshot" required><input name="right" placeholder="target snapshot" required><button class="action" type="submit">Compare</button></form></details></article>
        <article class="panel"><div class="panel-head"><div><p class="eyebrow">AUDIT</p><h2>Live event stream</h2></div></div><input id="event-filter" class="filter-input" type="search" placeholder="Filter events" autocomplete="off"><div id="events" class="timeline"></div></article>
      </section>
      <section class="panel remote-panel"><div class="panel-head"><div><p class="eyebrow">REMOTE WORKSPACES</p><h2>Verified code, live sync, tunnels &amp; BuildKit over SSH</h2></div></div><div id="remotes"></div><details open><summary>Operate a remote workspace</summary><form id="remote-operation-form" class="remote-form"><input name="name" placeholder="remote name" required><select name="operation"><option value="sync">sync code + state</option><option value="launch">launch workspace</option><option value="live-sync">live-sync once</option><option value="tunnel-start">start tunnels</option><option value="tunnel-status">tunnel status</option><option value="tunnel-stop">stop tunnels</option><option value="build">BuildKit build</option><option value="cache-inspect">cache inspect</option><option value="cache-prune">cache prune</option><option>trust</option><option>list</option><option>snapshots</option><option>preview</option><option>spawn</option><option>start</option><option>stop</option><option>reset</option><option>destroy</option></select><input name="branch" placeholder="branch (workspace operations)"><input name="snapshot" placeholder="snapshot (default if empty)"><input name="tag" placeholder="image tag (build)"><input name="context" placeholder="context (default .)"><input name="dockerfile" placeholder="Dockerfile path"><input name="cacheMax" placeholder="cache cap (default 20gb)"><select name="network"><option value="default">build network: default</option><option value="none">build network: none</option></select><label><input name="start" type="checkbox" checked> Start stack</label><label><input name="trustPolicy" type="checkbox"> Trust remote policy</label><label><input name="noCache" type="checkbox"> Build without cache</label><button class="action" type="submit">Run remotely</button></form></details><details><summary>Add remote</summary><form id="remote-form" class="remote-form"><input name="name" placeholder="name" required><input name="host" placeholder="host" required><input name="user" placeholder="SSH user"><input name="port" placeholder="22" inputmode="numeric"><input name="repoPath" placeholder="/absolute/remote/repo" required><input name="identityFile" placeholder="~/.ssh/id_ed25519"><input name="binary" placeholder="branchlift"><button class="action" type="submit">Add remote</button></form></details></section>
    </div>
  </main>
  <dialog id="logs-dialog"><div class="dialog-head"><h2 id="logs-title">Logs</h2><button id="close-logs" class="ghost">Close</button></div><pre id="logs-output"></pre></dialog>
  <div id="toast" role="status"></div>
  <script src="/app.js" defer></script>
</body>
</html>`;

const css = String.raw`:root{color-scheme:dark;--bg:#080b10;--panel:#10151d;--panel2:#141b25;--line:#253041;--text:#edf4ff;--muted:#91a0b5;--green:#57e39a;--amber:#ffc760;--red:#ff6b78;--blue:#72a7ff;--shadow:0 24px 80px #0008;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 70% -10%,#16335b55,transparent 35%),radial-gradient(circle at 5% 10%,#0f4c3950,transparent 26%),var(--bg);color:var(--text);min-height:100vh}header{height:72px;border-bottom:1px solid #202837cc;background:#080b10dd;backdrop-filter:blur(18px);display:flex;align-items:center;justify-content:space-between;padding:0 max(24px,calc((100vw - 1440px)/2));position:sticky;top:0;z-index:10}.brand,.header-right,.dialog-head,.panel-head{display:flex;align-items:center;gap:12px}.brand strong{display:block;font-size:15px;letter-spacing:.02em}.brand small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.mark{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#5ce0a0,#4d89ff);color:#07100d;font-weight:900;font-size:12px;box-shadow:0 8px 30px #47cc9f44}main{max-width:1440px;margin:auto;padding:44px 24px 80px}.hero{display:flex;justify-content:space-between;align-items:end;margin-bottom:26px}.hero h1{font-size:clamp(28px,4vw,46px);letter-spacing:-.04em;margin:3px 0 6px}.eyebrow{font-size:10px;letter-spacing:.18em;color:#6edba3;margin:0 0 7px;font-weight:800}.muted{color:var(--muted);font-size:12px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:14px}.stat,.panel{border:1px solid var(--line);background:linear-gradient(145deg,#121923e8,#0d1219e8);box-shadow:var(--shadow);border-radius:16px}.stat{padding:18px}.stat span{display:block;color:var(--muted);font-size:11px}.stat strong{font-size:26px;display:block;margin-top:7px;letter-spacing:-.03em}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.grid.wide-left{grid-template-columns:minmax(0,1.65fr) minmax(300px,.75fr)}.panel{padding:20px;min-width:0}.remote-panel{margin-top:14px}.panel-head{justify-content:space-between;margin-bottom:14px}.panel h2,.dialog-head h2{font-size:17px;margin:0}.pill{display:inline-flex;align-items:center;border:1px solid #355143;border-radius:999px;padding:6px 10px;font-size:10px;font-weight:750;color:var(--green);background:#17322588}.pill.warning{color:var(--amber);border-color:#5d4a29;background:#34281288}.pill.error{color:var(--red);border-color:#5e3037;background:#351b2188}.ghost,.action{border:1px solid var(--line);background:#151c26;color:var(--text);border-radius:9px;padding:8px 11px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.ghost:hover,.action:hover{border-color:#5273a0;background:#192331}.action.danger:hover{border-color:#9d3b48;color:#ff919b}.hidden{display:none!important}.instance-list{display:grid;gap:10px}.instance{border:1px solid #222d3c;border-radius:12px;padding:14px;background:#0d121a}.instance-top{display:flex;justify-content:space-between;gap:14px}.instance h3{font-size:14px;margin:0 0 4px}.instance-meta{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.services,.endpoints,.actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}.service{font-size:10px;background:#17202b;border:1px solid #29374a;padding:5px 7px;border-radius:7px}.service.running{color:var(--green)}.service.exited,.service.dead{color:var(--red)}.endpoint{color:#aac9ff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;border-bottom:1px solid #202b39;padding:10px 7px;font-size:11px}.table th{color:var(--muted);font-weight:600}.empty{padding:26px 10px;text-align:center;color:var(--muted);font-size:12px}.security-row{display:flex;justify-content:space-between;border-bottom:1px solid #202b39;padding:9px 0;font-size:11px}.security-row span{color:var(--muted)}.secret-summary{margin-top:16px}.timeline{max-height:390px;overflow:auto;padding-right:4px}.event{position:relative;border-left:1px solid #2b394c;padding:0 0 16px 16px;margin-left:5px}.event:before{content:"";position:absolute;left:-4px;top:3px;width:7px;height:7px;border-radius:50%;background:var(--blue);box-shadow:0 0 0 4px #16243a}.event.error:before{background:var(--red)}.event.warning:before{background:var(--amber)}.event strong{font-size:11px}.event p{margin:4px 0;color:var(--muted);font-size:11px}.event time{font-size:9px;color:#607188}details{margin-top:14px;border-top:1px solid var(--line);padding-top:13px}summary{cursor:pointer;color:var(--blue);font-size:11px;font-weight:750}.remote-form,.control-form{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;margin-top:12px}.remote-form input,.remote-form select,.control-form input{background:#0b1017;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:9px;font:inherit;font-size:11px}.control-form label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}.remote-form input[name=repoPath]{grid-column:span 2}dialog{width:min(980px,calc(100vw - 40px));height:min(700px,calc(100vh - 60px));background:#0d1219;border:1px solid var(--line);border-radius:16px;color:var(--text);box-shadow:var(--shadow);padding:18px}dialog::backdrop{background:#020408c9;backdrop-filter:blur(5px)}.dialog-head{justify-content:space-between}pre{height:calc(100% - 50px);overflow:auto;background:#070a0f;border:1px solid #202b39;padding:14px;border-radius:10px;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}#toast{position:fixed;right:24px;bottom:24px;max-width:420px;padding:12px 15px;border-radius:10px;background:#172332;border:1px solid #35506c;box-shadow:var(--shadow);font-size:12px;transform:translateY(120px);opacity:0;transition:.25s;z-index:20}#toast.show{transform:none;opacity:1}.locked{text-align:center;padding:100px 20px}.locked h1{font-size:30px}@media(max-width:900px){.stats{grid-template-columns:1fr 1fr}.grid,.grid.wide-left{grid-template-columns:1fr}.hero{align-items:start;flex-direction:column;gap:12px}.remote-form,.control-form{grid-template-columns:1fr 1fr}}@media(max-width:540px){main{padding:28px 14px 60px}header{padding:0 14px}.stats{grid-template-columns:1fr}.instance-top{flex-direction:column}.header-right .pill{display:none}.remote-form,.control-form{grid-template-columns:1fr}.remote-form input[name=repoPath]{grid-column:auto}}.filter-input{width:100%;background:#0b1017;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 11px;font:inherit;font-size:11px;margin-bottom:10px}.filter-input:focus{outline:none;border-color:#5273a0;background:#0e141d}.endpoint{cursor:pointer;border-radius:6px;padding:2px 4px;transition:background .15s,color .15s}.endpoint:hover{background:#16243a;color:#d3e5ff}.instance,.event,.table tbody tr{transition:opacity .15s}`;

const javascript = String.raw`(() => {
  const tokenFromHash = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '';
  if (tokenFromHash) { sessionStorage.setItem('branchlift-token', tokenFromHash); history.replaceState(null, '', location.pathname); }
  const token = sessionStorage.getItem('branchlift-token') || '';
  const app = document.getElementById('app'); const locked = document.getElementById('locked');
  if (!token) { locked.classList.remove('hidden'); return; } app.classList.remove('hidden');
  const headers = { Authorization: 'Bearer ' + token };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const bytes = n => { const u=['B','KiB','MiB','GiB','TiB']; let i=0,v=Number(n||0); while(v>=1024&&i<u.length-1){v/=1024;i++;} return (v>=10||i===0?v.toFixed(0):v.toFixed(1))+' '+u[i]; };
  const ago = s => { const d=Math.max(0,Date.now()-Date.parse(s)); if(d<60000)return Math.floor(d/1000)+'s ago'; if(d<3600000)return Math.floor(d/60000)+'m ago'; if(d<86400000)return Math.floor(d/3600000)+'h ago'; return Math.floor(d/86400000)+'d ago'; };
  async function api(path, options={}) { const response=await fetch(path,{...options,headers:{...headers,...(options.headers||{})}}); const body=await response.json().catch(()=>({error:'Invalid response'})); if(!response.ok) throw new Error(body.error||('HTTP '+response.status)); return body; }
  function toast(message,error=false){ const el=document.getElementById('toast'); el.textContent=message; el.style.borderColor=error?'#8b3843':'#35506c'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3500); }
  function render(data) {
    document.getElementById('repo-name').textContent=data.repository.name; document.getElementById('repo-root').textContent=data.repository.root; document.getElementById('generated').textContent='Updated '+ago(data.generatedAt);
    const running=data.instances.filter(x=>x.status==='running').length; const healthy=data.instances.filter(x=>(x.services||[]).every(s=>s.state==='running'&&(!s.health||s.health==='healthy'))).length;
    document.getElementById('stats').innerHTML=[['Running environments',running],['Healthy stacks',healthy+'/'+data.instances.length],['Immutable snapshots',data.snapshots.length],['Audit events',data.events.length]].map(x=>'<div class="stat"><span>'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong></div>').join('');
    document.getElementById('instances').innerHTML=data.instances.length?data.instances.map(instance=>'<div class="instance"><div class="instance-top"><div><h3>'+esc(instance.branch)+'</h3><div class="instance-meta">'+esc(instance.snapshot)+' · '+esc(instance.worktreePath)+'</div></div><span class="pill '+(instance.status==='failed'?'error':instance.status==='running'?'':'warning')+'">'+esc(instance.status)+'</span></div><div class="services">'+(instance.services||[]).map(s=>'<span class="service '+esc(s.state)+'">'+esc(s.service)+' · '+esc(s.health||s.state)+'</span>').join('')+'</div><div class="endpoints">'+instance.endpoints.map(e=>'<span class="endpoint">'+esc(e.service)+': '+esc(e.url)+'</span>').join('')+'</div><div class="actions"><button class="action" data-action="logs" data-branch="'+esc(instance.branch)+'">Logs</button>'+(instance.status==='running'?'<button class="action" data-action="stop" data-branch="'+esc(instance.branch)+'">Stop</button>':'<button class="action" data-action="start" data-branch="'+esc(instance.branch)+'">Start</button>')+'<button class="action" data-action="reset" data-branch="'+esc(instance.branch)+'">Reset</button><button class="action danger" data-action="destroy" data-branch="'+esc(instance.branch)+'">Destroy</button></div></div>').join(''):'<div class="empty">No environments yet.</div>';
    const sec=data.security; document.getElementById('security').innerHTML=[['Policy',data.policy.trusted?'trusted':'approval required'],['Boundary',sec.boundary],['Backend',sec.backend],['Network',sec.network],['Root filesystem',sec.readOnlyRoot?'read-only':'writable'],['Capabilities',sec.capabilities],['Docker socket',sec.hostDockerSocketMounted?'mounted':'not mounted'],['Resource limits',sec.resourceLimits.memory+' · '+sec.resourceLimits.cpus+' CPU · '+sec.resourceLimits.pids+' PIDs']].map(x=>'<div class="security-row"><span>'+esc(x[0])+'</span><strong>'+esc(x[1])+'</strong></div>').join('');
    document.getElementById('secrets').innerHTML='<div class="secret-summary"><p class="eyebrow">SECRET BROKER</p>'+(data.secrets.length?data.secrets.map(s=>'<div class="security-row"><span>'+esc(s.name)+' → '+esc(s.target)+'</span><strong style="color:'+(s.available?'var(--green)':'var(--red)')+'">'+(s.available?'available':s.required?'missing':'optional')+'</strong></div>').join(''):'<p class="muted">No scoped secrets configured.</p>')+'</div>';
    document.getElementById('snapshots').innerHTML=data.snapshots.length?'<table class="table"><thead><tr><th>Name</th><th>Parent</th><th>Size</th><th>Content</th><th>Created</th></tr></thead><tbody>'+data.snapshots.map(s=>'<tr><td><strong>'+esc(s.name)+'</strong></td><td>'+esc(s.parentSnapshot||'root')+'</td><td>'+esc(bytes(s.sizeBytes))+'</td><td>'+esc(s.contentDigest?s.contentDigest.slice(0,12):'not indexed')+'</td><td>'+esc(ago(s.createdAt))+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No snapshots yet.</div>';
    document.getElementById('events').innerHTML=data.events.length?data.events.map(e=>'<div class="event '+esc(e.level)+'"><strong>'+esc(e.kind)+'</strong><p>'+esc(e.message)+'</p><time>'+esc(ago(e.timestamp))+'</time></div>').join(''):'<div class="empty">No audit events yet.</div>';
    document.getElementById('remotes').innerHTML=data.remotes.length?'<table class="table"><thead><tr><th>Name</th><th>Target</th><th>Repository</th><th>Worker</th><th></th></tr></thead><tbody>'+data.remotes.map(r=>'<tr><td><strong>'+esc(r.name)+'</strong></td><td>'+esc((r.user?r.user+'@':'')+r.host+':'+r.port)+'</td><td>'+esc(r.repoPath)+'</td><td>'+esc(r.managedBinary?'managed '+(r.lastSetupAt?ago(r.lastSetupAt):''):'external/unverified')+'</td><td><div class="actions"><button class="action" data-remote-action="ping" data-remote="'+esc(r.name)+'">Ping</button><button class="action" data-remote-action="setup" data-remote="'+esc(r.name)+'">Setup</button><button class="action danger" data-remote-action="remove" data-remote="'+esc(r.name)+'">Remove</button></div></td></tr>').join('')+'</tbody></table>':'<div class="empty">No SSH remotes configured.</div>';
    document.getElementById('connection').textContent='Live'; document.getElementById('connection').className='pill';
  }
  let loading=false; async function load(){ if(loading)return; loading=true; try{render(await api('/api/state'));applyFilters();}catch(e){document.getElementById('connection').textContent='Disconnected';document.getElementById('connection').className='pill error';toast(e.message,true);}finally{loading=false;} }
  document.getElementById('refresh').addEventListener('click',load); document.getElementById('close-logs').addEventListener('click',()=>document.getElementById('logs-dialog').close());
  document.getElementById('instances').addEventListener('click',async event=>{const button=event.target.closest('button[data-action]');if(!button)return;const action=button.dataset.action,branch=button.dataset.branch;button.disabled=true;try{if(action==='logs'){const result=await api('/api/logs?branch='+encodeURIComponent(branch));document.getElementById('logs-title').textContent=branch+' logs';document.getElementById('logs-output').textContent=result.logs||'No logs.';document.getElementById('logs-dialog').showModal();return;}let confirmValue;if(action==='reset'||action==='destroy'){if(!confirm(action+' '+branch+'?'))return;confirmValue=branch;}await api('/api/actions/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({branch,confirm:confirmValue})});toast(action+' completed for '+branch);await load();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  document.getElementById('remotes').addEventListener('click',async event=>{const button=event.target.closest('button[data-remote-action]');if(!button)return;const action=button.dataset.remoteAction,name=button.dataset.remote;button.disabled=true;try{if(action==='remove'&&!confirm('Remove remote '+name+'?'))return;const result=await api('/api/actions/remote-'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,confirm:action==='remove'?name:undefined})});toast(action==='ping'?'Remote '+name+' reachable ('+result.latencyMs+' ms)':action==='setup'?'Remote '+name+' worker installed and verified':'Remote '+name+' removed');await load();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  document.getElementById('remote-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),values=Object.fromEntries(new FormData(form).entries());button.disabled=true;try{if(values.port)values.port=Number(values.port);for(const key of Object.keys(values)){if(values[key]==='')delete values[key];}await api('/api/actions/remote-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});toast('Remote '+values.name+' added');form.reset();await load();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  document.getElementById('remote-operation-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),values=Object.fromEntries(new FormData(form).entries());values.start=form.elements.start.checked;values.trustPolicy=form.elements.trustPolicy.checked;values.noCache=form.elements.noCache.checked;for(const key of Object.keys(values)){if(values[key]==='')delete values[key];}if(['launch','live-sync','tunnel-start','tunnel-status','tunnel-stop','reset','destroy'].includes(values.operation)&&!values.branch){toast('A branch is required',true);return;}if(values.operation==='build'&&!values.tag){toast('An image tag is required for a build',true);return;}if(values.operation==='reset'||values.operation==='destroy'){if(!confirm(values.operation+' '+values.branch+' on '+values.name+'?'))return;values.confirm=values.branch;}if(values.operation==='cache-prune'){if(!confirm('Prune BranchLift scoped build cache on '+values.name+'?'))return;values.confirm='prune';}button.disabled=true;try{const result=await api('/api/actions/remote-operate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});if(['sync','launch','live-sync','tunnel-start','tunnel-status','tunnel-stop','build','cache-inspect','cache-prune','list','snapshots','preview'].includes(values.operation)){document.getElementById('logs-title').textContent=values.name+' · '+values.operation;document.getElementById('logs-output').textContent=JSON.stringify(result.result,null,2);document.getElementById('logs-dialog').showModal();}else toast(values.operation+' completed on '+values.name);await load();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  document.getElementById('spawn-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),values=Object.fromEntries(new FormData(form).entries());values.start=form.elements.start.checked;if(!values.snapshot)delete values.snapshot;button.disabled=true;try{await api('/api/actions/spawn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});toast('Environment '+values.branch+' spawned');form.reset();form.elements.start.checked=true;await load();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  document.getElementById('commit-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),values=Object.fromEntries(new FormData(form).entries());button.disabled=true;try{await api('/api/actions/snapshot-commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});toast('Snapshot '+values.name+' committed');form.reset();await load();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  document.getElementById('diff-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),values=Object.fromEntries(new FormData(form).entries());button.disabled=true;try{const result=await api('/api/actions/snapshot-diff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});document.getElementById('logs-title').textContent=values.left+' → '+values.right;document.getElementById('logs-output').textContent=JSON.stringify(result.diff,null,2);document.getElementById('logs-dialog').showModal();}catch(e){toast(e.message,true);}finally{button.disabled=false;}});
  async function live(){try{const response=await fetch('/api/events/stream',{headers});if(!response.ok)throw new Error('stream '+response.status);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.includes('\n\n')){buffer=buffer.slice(buffer.lastIndexOf('\n\n')+2);load();}}}catch{setTimeout(live,2500);}}
  const applyFilters=()=>{const q=id=>((document.getElementById(id)||{}).value||'').trim().toLowerCase();const match=(el,term)=>!term||el.textContent.toLowerCase().includes(term);
    document.querySelectorAll('#instances .instance').forEach(el=>{el.style.display=match(el,q('instance-filter'))?'':'none';});
    document.querySelectorAll('#snapshots tbody tr').forEach(el=>{el.style.display=match(el,q('snapshot-filter'))?'':'none';});
    document.querySelectorAll('#events .event').forEach(el=>{el.style.display=match(el,q('event-filter'))?'':'none';});};
  ['instance-filter','snapshot-filter','event-filter'].forEach(id=>{const input=document.getElementById(id);if(input)input.addEventListener('input',applyFilters);});
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes((document.activeElement||{}).tagName||'')){e.preventDefault();document.getElementById('instance-filter')?.focus();}if(e.key==='Escape'&&document.activeElement&&document.activeElement.classList&&document.activeElement.classList.contains('filter-input')){document.activeElement.value='';applyFilters();}});
  document.getElementById('app').addEventListener('click',e=>{const endpoint=e.target.closest('.endpoint');if(!endpoint)return;const url=endpoint.textContent.split(': ').slice(1).join(': ');if(!url)return;navigator.clipboard&&navigator.clipboard.writeText(url).then(()=>toast('Copied '+url)).catch(()=>toast('Could not copy URL',true));});
  load(); live(); setInterval(load,15000);
})();`;
