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
  <meta name="theme-color" content="#f4f5f7">
  <title>BranchLift Control Plane</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <section id="locked" class="locked hidden">
    <div class="locked-card"><span class="mark large">BL</span><p class="eyebrow">LOCAL CONTROL PLANE</p><h1>Session token required</h1><p>Open the exact loopback URL printed by <code>branchlift ui</code>.</p></div>
  </section>
  <div id="app" class="desktop-shell hidden">
    <aside class="sidebar" aria-label="Primary navigation">
      <div class="window-controls" aria-hidden="true"><span class="traffic red"></span><span class="traffic amber"></span><span class="traffic green"></span></div>
      <div class="brand"><span class="mark">BL</span><div><strong>BranchLift</strong><small>Control Plane</small></div></div>
      <nav class="navigation">
        <button class="nav-item active" data-view="overview"><span class="nav-icon">⌂</span><span>Overview</span></button>
        <button class="nav-item" data-view="environments"><span class="nav-icon">⌘</span><span>Environments</span><span id="nav-instance-count" class="nav-count">0</span></button>
        <button class="nav-item" data-view="state"><span class="nav-icon">◫</span><span>State</span></button>
        <button class="nav-item" data-view="security"><span class="nav-icon">◇</span><span>Security</span></button>
        <button class="nav-item" data-view="remotes"><span class="nav-icon">↗</span><span>Remotes</span></button>
        <button class="nav-item" data-view="activity"><span class="nav-icon">≋</span><span>Activity</span></button>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-status"><span class="status-orb"></span><div><strong>Local only</strong><small>Token protected · loopback</small></div></div>
        <button id="open-command-sidebar" class="shortcut-row"><span>Quick actions</span><kbd>⌘ K</kbd></button>
      </div>
    </aside>

    <section class="workspace">
      <header class="toolbar">
        <div class="toolbar-title"><span id="toolbar-section">Overview</span><span class="toolbar-separator">/</span><strong id="toolbar-repo">Repository</strong></div>
        <div class="toolbar-actions">
          <span id="connection" class="pill warning"><span class="pulse"></span>Connecting</span>
          <button id="theme-toggle" class="icon-button" aria-label="Toggle appearance" title="Toggle appearance">◐</button>
          <button id="open-command" class="toolbar-button"><span>Quick actions</span><kbd>⌘ K</kbd></button>
          <button id="refresh" class="icon-button" aria-label="Refresh state" title="Refresh state">↻</button>
          <button class="action primary" data-open-spawn><span>＋</span> New environment</button>
        </div>
      </header>

      <main class="content">
        <section class="workspace-view active" data-view-panel="overview">
          <div class="hero">
            <div><p class="eyebrow">STATEFUL DEVELOPMENT, WITHOUT COLLISIONS</p><h1 id="repo-name">Repository</h1><p id="repo-root" class="muted path"></p></div>
            <div class="hero-meta"><span id="generated">Loading state…</span><span class="hero-divider"></span><span>No account · no hosted service</span></div>
          </div>

          <article id="onboarding" class="onboarding panel skeleton-block" aria-live="polite"></article>
          <section id="stats" class="stats" aria-label="Repository status"></section>

          <section class="dashboard-grid">
            <article class="panel span-7">
              <div class="panel-head"><div><p class="eyebrow">FLEET HEALTH</p><h2>Active environments</h2></div><button class="text-button" data-nav="environments">View all <span>→</span></button></div>
              <div id="overview-instances" class="compact-list skeleton-block"></div>
            </article>
            <article class="panel span-5">
              <div class="panel-head"><div><p class="eyebrow">LIVE SIGNAL</p><h2>Recent activity</h2></div><button class="text-button" data-nav="activity">Open stream <span>→</span></button></div>
              <div id="overview-events" class="timeline compact skeleton-block"></div>
            </article>
          </section>

          <article class="capability-strip panel">
            <div><span class="capability-icon">◈</span><strong>Immutable state lineage</strong><small>commit · semantic diff · reset</small></div>
            <div><span class="capability-icon">⌾</span><strong>Agent-safe execution</strong><small>no host socket · scoped secrets</small></div>
            <div><span class="capability-icon">↗</span><strong>Your machines, remotely</strong><small>live sync · tunnels · BuildKit</small></div>
          </article>
        </section>

        <section class="workspace-view" data-view-panel="environments">
          <div class="section-heading"><div><p class="eyebrow">ISOLATED RUNTIMES</p><h1>Environments</h1><p>Every branch gets its own worktree, backend volumes, network, and conflict-free ports.</p></div><button class="action primary" data-open-spawn>＋ New environment</button></div>
          <article class="panel">
            <div class="panel-head filter-head"><div><h2>Branch environments</h2><span id="environment-summary" class="muted">Loading…</span></div><div class="search-wrap"><span>⌕</span><input id="instance-filter" class="filter-input" type="search" placeholder="Filter environments (press /)" aria-label="Filter environments" autocomplete="off"></div></div>
            <div id="instances" class="instance-list skeleton-block"></div>
          </article>
        </section>

        <section class="workspace-view" data-view-panel="state">
          <div class="section-heading"><div><p class="eyebrow">DATA PLANE</p><h1>State lineage</h1><p>Turn a mutated environment into a child snapshot, inspect the delta, or reset to a known state.</p></div><span class="feature-badge">content addressed</span></div>
          <section class="dashboard-grid state-grid">
            <article class="panel span-8">
              <div class="panel-head filter-head"><div><h2>Immutable snapshots</h2><span class="muted">Dependency-protected history</span></div><div class="search-wrap"><span>⌕</span><input id="snapshot-filter" class="filter-input" type="search" placeholder="Filter snapshots" aria-label="Filter snapshots" autocomplete="off"></div></div>
              <div id="snapshots" class="skeleton-block"></div>
            </article>
            <aside class="panel span-4 action-panel">
              <p class="eyebrow">STATE ACTIONS</p><h2>Commit a mutation</h2><p class="muted">Capture a stopped, crash-consistent child snapshot from an environment.</p>
              <form id="commit-form" class="stack-form">
                <label class="field"><span>Snapshot name</span><input name="name" placeholder="auth-fixed" required></label>
                <label class="field"><span>Source branch</span><input name="branch" placeholder="agent/fix-auth" required></label>
                <button class="action primary full" type="submit">Commit state</button>
              </form>
              <div class="form-divider"><span>or compare</span></div>
              <form id="diff-form" class="stack-form two-up">
                <label class="field"><span>Base</span><input name="left" placeholder="dev" required></label>
                <label class="field"><span>Target</span><input name="right" placeholder="auth-fixed" required></label>
                <button class="action secondary full-span" type="submit">View semantic diff</button>
              </form>
            </aside>
          </section>
        </section>

        <section class="workspace-view" data-view-panel="security">
          <div class="section-heading"><div><p class="eyebrow">EXECUTION BOUNDARY</p><h1>Security</h1><p>See the effective policy before an agent command touches your project.</p></div><span id="security-score" class="security-score">Checking…</span></div>
          <section class="dashboard-grid">
            <article class="panel span-7"><div class="panel-head"><div><h2>Effective posture</h2><span class="muted">Derived from the active project policy</span></div><span class="shield">◇</span></div><div id="security" class="skeleton-block"></div></article>
            <article class="panel span-5"><div class="panel-head"><div><h2>Secret broker</h2><span class="muted">Scoped at process launch</span></div></div><div id="secrets" class="skeleton-block"></div></article>
          </section>
          <article class="panel security-callout"><div class="callout-icon">✓</div><div><strong>Agent commands stay away from the host Docker socket.</strong><p>The sandbox drops Linux capabilities, uses a read-only root and applies project-reviewed network and resource limits. This is a container boundary, not a hostile multi-tenant VM boundary.</p></div><button class="copy-command action secondary" data-copy="branchlift security inspect">Copy inspect command</button></article>
        </section>

        <section class="workspace-view" data-view-panel="remotes">
          <div class="section-heading"><div><p class="eyebrow">REMOTE WORKSPACES</p><h1>Your machines, one command away</h1><p>Verified code, live sync, tunnels &amp; BuildKit over strict-host-key SSH — no hosted control service.</p></div><span class="feature-badge">zero BranchLift subscription</span></div>
          <article class="panel"><div class="panel-head"><div><h2>SSH workers</h2><span class="muted">User-scoped · sudo-free setup</span></div></div><div id="remotes" class="skeleton-block"></div></article>
          <section class="dashboard-grid remote-grid">
            <article class="panel span-7 action-panel">
              <p class="eyebrow">OPERATE</p><h2>Remote workspace action</h2><p class="muted">Only fields relevant to the selected operation are shown.</p>
              <form id="remote-operation-form" class="remote-operation-form">
                <label class="field"><span>Remote</span><input name="name" placeholder="lab" required></label>
                <label class="field"><span>Operation</span><select id="remote-operation" name="operation"><option value="sync">Sync committed code + state</option><option value="launch">Launch workspace</option><option value="live-sync">Live-sync once</option><option value="tunnel-start">Start tunnels</option><option value="tunnel-status">Tunnel status</option><option value="tunnel-stop">Stop tunnels</option><option value="build">BuildKit build</option><option value="cache-inspect">Inspect build cache</option><option value="cache-prune">Prune build cache</option><option value="trust">Trust project policy</option><option value="list">List environments</option><option value="snapshots">List snapshots</option><option value="preview">Preview services</option><option value="spawn">Spawn environment</option><option value="start">Start environment</option><option value="stop">Stop environment</option><option value="reset">Reset environment</option><option value="destroy">Destroy environment</option></select></label>
                <label class="field remote-field" data-ops="launch,live-sync,tunnel-start,tunnel-status,tunnel-stop,build,spawn,start,stop,reset,destroy"><span>Branch</span><input name="branch" placeholder="agent/fix-auth"></label>
                <label class="field remote-field" data-ops="launch,spawn"><span>Snapshot</span><input name="snapshot" placeholder="dev (default)"></label>
                <label class="field remote-field" data-ops="build"><span>Image tag</span><input name="tag" placeholder="my-api:dev"></label>
                <label class="field remote-field" data-ops="build"><span>Build context</span><input name="context" placeholder="."></label>
                <label class="field remote-field" data-ops="build"><span>Dockerfile</span><input name="dockerfile" placeholder="Dockerfile"></label>
                <label class="field remote-field" data-ops="build,cache-prune"><span>Cache cap</span><input name="cacheMax" placeholder="20gb"></label>
                <label class="field remote-field" data-ops="build"><span>Build network</span><select name="network"><option value="default">Default</option><option value="none">None</option></select></label>
                <label class="check-field remote-field" data-ops="launch,spawn"><input name="start" type="checkbox" checked><span>Start stack after creation</span></label>
                <label class="check-field remote-field" data-ops="launch"><input name="trustPolicy" type="checkbox"><span>Trust reviewed remote policy</span></label>
                <label class="check-field remote-field" data-ops="build"><input name="noCache" type="checkbox"><span>Build without cache</span></label>
                <button class="action primary full-span" type="submit">Run on remote <span>→</span></button>
              </form>
            </article>
            <article class="panel span-5 action-panel">
              <p class="eyebrow">CONNECT A MACHINE</p><h2>Add an SSH worker</h2><p class="muted">BranchLift verifies the host key and installs a user-scoped worker on first sync.</p>
              <form id="remote-form" class="stack-form two-up">
                <label class="field"><span>Name</span><input name="name" placeholder="lab" required></label>
                <label class="field"><span>Host</span><input name="host" placeholder="192.0.2.10" required></label>
                <label class="field"><span>SSH user</span><input name="user" placeholder="developer"></label>
                <label class="field"><span>Port</span><input name="port" placeholder="22" inputmode="numeric"></label>
                <label class="field full-span"><span>Repository path</span><input name="repoPath" placeholder="/home/developer/projects/app" required></label>
                <details class="advanced full-span"><summary>Advanced connection options</summary><div class="two-up nested-fields"><label class="field"><span>Identity file</span><input name="identityFile" placeholder="~/.ssh/id_ed25519"></label><label class="field"><span>Worker binary</span><input name="binary" placeholder="branchlift"></label></div></details>
                <button class="action secondary full-span" type="submit">Add and verify remote</button>
              </form>
            </article>
          </section>
        </section>

        <section class="workspace-view" data-view-panel="activity">
          <div class="section-heading"><div><p class="eyebrow">AUDIT TRAIL</p><h1>Activity</h1><p>A local, live record of lifecycle, policy, snapshot, and remote operations.</p></div><span class="live-label"><span class="pulse"></span>Streaming</span></div>
          <article class="panel"><div class="panel-head filter-head"><div><h2>Live event stream</h2><span class="muted">Newest events first</span></div><div class="search-wrap"><span>⌕</span><input id="event-filter" class="filter-input" type="search" placeholder="Filter events" aria-label="Filter events" autocomplete="off"></div></div><div id="events" class="timeline activity-timeline skeleton-block"></div></article>
        </section>
      </main>
    </section>
  </div>

  <dialog id="spawn-dialog" class="sheet-dialog">
    <div class="dialog-head"><div><p class="eyebrow">NEW ISOLATED RUNTIME</p><h2>Create an environment</h2></div><button class="icon-button dialog-close" data-close-dialog="spawn-dialog" aria-label="Close">×</button></div>
    <p class="dialog-copy">BranchLift creates or attaches a worktree, clones backend state, assigns ports, and keeps the environment isolated.</p>
    <form id="spawn-form" class="stack-form">
      <label class="field"><span>Branch name</span><input name="branch" placeholder="agent/fix-auth" autocomplete="off" required><small>An existing branch is attached; a missing branch is created.</small></label>
      <label class="field"><span>Starting snapshot <em>optional</em></span><input name="snapshot" placeholder="Project default"></label>
      <label class="check-card"><input name="start" type="checkbox" checked><span><strong>Start services immediately</strong><small>Compose services start after state is cloned.</small></span></label>
      <div class="dialog-actions"><button class="action secondary" type="button" data-close-dialog="spawn-dialog">Cancel</button><button class="action primary" type="submit">Create environment</button></div>
    </form>
  </dialog>

  <dialog id="command-dialog" class="command-dialog">
    <div class="command-search"><span>⌕</span><input id="command-search" type="search" placeholder="Search actions and sections…" aria-label="Search quick actions" autocomplete="off"><kbd>esc</kbd></div>
    <div id="command-list" class="command-list">
      <button data-command="spawn"><span class="command-icon">＋</span><span><strong>New environment</strong><small>Create isolated state for a branch</small></span><kbd>↵</kbd></button>
      <button data-command="refresh"><span class="command-icon">↻</span><span><strong>Refresh state</strong><small>Reload the local control plane</small></span></button>
      <button data-command="environments"><span class="command-icon">⌘</span><span><strong>Open environments</strong><small>Start, stop, reset, or inspect logs</small></span></button>
      <button data-command="state"><span class="command-icon">◫</span><span><strong>Open state lineage</strong><small>Commit and compare snapshots</small></span></button>
      <button data-command="security"><span class="command-icon">◇</span><span><strong>Open security</strong><small>Inspect the effective sandbox posture</small></span></button>
      <button data-command="remotes"><span class="command-icon">↗</span><span><strong>Open remotes</strong><small>Sync, tunnel, and build on your machines</small></span></button>
    </div>
  </dialog>

  <dialog id="logs-dialog" class="logs-dialog"><div class="dialog-head"><div><p class="eyebrow">OUTPUT</p><h2 id="logs-title">Logs</h2></div><button id="close-logs" class="icon-button" aria-label="Close">×</button></div><pre id="logs-output"></pre></dialog>
  <div id="toast" role="status" aria-live="polite"></div>
  <script src="/app.js" defer></script>
</body>
</html>`;

const css = String.raw`:root {
  color-scheme: light dark;
  --bg: #e8e9ed;
  --desktop: rgba(247, 248, 250, .82);
  --sidebar: rgba(232, 234, 239, .76);
  --toolbar: rgba(249, 250, 252, .78);
  --panel: rgba(255, 255, 255, .82);
  --panel-solid: #fff;
  --panel-soft: #f3f4f7;
  --field: rgba(244, 245, 248, .9);
  --line: rgba(19, 27, 44, .11);
  --line-strong: rgba(19, 27, 44, .18);
  --text: #17191f;
  --text-secondary: #50535d;
  --muted: #797d89;
  --accent: #356df3;
  --accent-hover: #285bd3;
  --accent-soft: rgba(53, 109, 243, .11);
  --green: #16885a;
  --green-soft: rgba(22, 136, 90, .11);
  --amber: #ae6800;
  --amber-soft: rgba(196, 117, 0, .12);
  --red: #d63c49;
  --red-soft: rgba(214, 60, 73, .1);
  --purple: #7756d8;
  --shadow-window: 0 30px 90px rgba(25, 30, 45, .22), 0 3px 12px rgba(25, 30, 45, .12);
  --shadow-panel: 0 1px 2px rgba(17, 23, 38, .05), 0 8px 24px rgba(17, 23, 38, .045);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #090b10; --desktop: rgba(24, 26, 32, .88); --sidebar: rgba(29, 31, 38, .8); --toolbar: rgba(27, 29, 35, .8);
    --panel: rgba(38, 40, 48, .78); --panel-solid: #25272e; --panel-soft: #202228; --field: rgba(25, 27, 33, .92);
    --line: rgba(255, 255, 255, .095); --line-strong: rgba(255, 255, 255, .16); --text: #f3f4f7; --text-secondary: #c1c4cc; --muted: #8f939e;
    --accent: #6694ff; --accent-hover: #82a8ff; --accent-soft: rgba(102, 148, 255, .14); --green: #4bd397; --green-soft: rgba(75, 211, 151, .12);
    --amber: #ffc35f; --amber-soft: rgba(255, 195, 95, .12); --red: #ff6976; --red-soft: rgba(255, 105, 118, .12); --purple: #a58bff;
    --shadow-window: 0 35px 110px rgba(0, 0, 0, .62), 0 3px 12px rgba(0, 0, 0, .35); --shadow-panel: 0 1px 1px rgba(0, 0, 0, .2), 0 10px 30px rgba(0, 0, 0, .12);
  }
}
:root[data-theme="dark"] {
  --bg: #090b10; --desktop: rgba(24, 26, 32, .88); --sidebar: rgba(29, 31, 38, .8); --toolbar: rgba(27, 29, 35, .8);
  --panel: rgba(38, 40, 48, .78); --panel-solid: #25272e; --panel-soft: #202228; --field: rgba(25, 27, 33, .92);
  --line: rgba(255, 255, 255, .095); --line-strong: rgba(255, 255, 255, .16); --text: #f3f4f7; --text-secondary: #c1c4cc; --muted: #8f939e;
  --accent: #6694ff; --accent-hover: #82a8ff; --accent-soft: rgba(102, 148, 255, .14); --green: #4bd397; --green-soft: rgba(75, 211, 151, .12);
  --amber: #ffc35f; --amber-soft: rgba(255, 195, 95, .12); --red: #ff6976; --red-soft: rgba(255, 105, 118, .12); --purple: #a58bff;
  --shadow-window: 0 35px 110px rgba(0, 0, 0, .62), 0 3px 12px rgba(0, 0, 0, .35); --shadow-panel: 0 1px 1px rgba(0, 0, 0, .2), 0 10px 30px rgba(0, 0, 0, .12);
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0; color: var(--text); background:
    radial-gradient(circle at 12% 0%, rgba(69, 130, 255, .18), transparent 30%),
    radial-gradient(circle at 92% 90%, rgba(86, 210, 151, .15), transparent 31%), var(--bg);
  font-size: 13px; -webkit-font-smoothing: antialiased;
}
button, input, select { font: inherit; }
button { color: inherit; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
.hidden { display: none !important; }
.desktop-shell {
  position: fixed; inset: 18px; max-width: 1720px; margin: auto; display: grid; grid-template-columns: 242px minmax(0, 1fr);
  overflow: hidden; border: 1px solid var(--line-strong); border-radius: 18px; background: var(--desktop); box-shadow: var(--shadow-window);
  -webkit-backdrop-filter: blur(34px) saturate(1.3); backdrop-filter: blur(34px) saturate(1.3);
}
.sidebar { display: flex; min-width: 0; flex-direction: column; border-right: 1px solid var(--line); background: var(--sidebar); padding: 15px 12px 13px; }
.window-controls { display: flex; gap: 8px; height: 30px; align-items: flex-start; padding: 1px 5px; }
.traffic { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(0,0,0,.12); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.32); }
.traffic.red { background: #ff5f57; }.traffic.amber { background: #febc2e; }.traffic.green { background: #28c840; }
.brand { display: flex; align-items: center; gap: 11px; padding: 10px 8px 19px; }
.brand strong, .brand small { display: block; }.brand strong { font-size: 14px; letter-spacing: -.01em; }.brand small { color: var(--muted); font-size: 10px; margin-top: 2px; }
.mark { display: grid; place-items: center; flex: 0 0 auto; width: 35px; height: 35px; border-radius: 10px; color: white; font-weight: 850; font-size: 10px; letter-spacing: -.02em; background: linear-gradient(145deg, #6ca2ff, #3267ed 55%, #254ec4); box-shadow: 0 7px 18px rgba(53,109,243,.29), inset 0 1px rgba(255,255,255,.36); }
.mark.large { width: 58px; height: 58px; border-radius: 16px; font-size: 16px; margin: 0 auto 20px; }
.navigation { display: grid; gap: 3px; }
.nav-item { width: 100%; height: 38px; display: grid; grid-template-columns: 23px 1fr auto; align-items: center; gap: 8px; border: 0; border-radius: 9px; padding: 0 10px; background: transparent; color: var(--text-secondary); text-align: left; cursor: pointer; font-size: 12px; font-weight: 570; }
.nav-item:hover { background: rgba(127, 130, 140, .09); color: var(--text); }.nav-item.active { background: var(--accent-soft); color: var(--accent); }
.nav-icon { font-size: 15px; text-align: center; font-weight: 450; }.nav-count { min-width: 19px; padding: 2px 5px; border-radius: 99px; background: rgba(127,130,140,.13); color: var(--muted); font-size: 9px; text-align: center; }
.nav-item.active .nav-count { background: var(--accent); color: white; }
.sidebar-footer { margin-top: auto; display: grid; gap: 8px; border-top: 1px solid var(--line); padding: 13px 5px 0; }
.sidebar-status { display: flex; align-items: center; gap: 9px; padding: 5px; }.sidebar-status strong,.sidebar-status small { display: block; }.sidebar-status strong { font-size: 10px; }.sidebar-status small { font-size: 9px; color: var(--muted); margin-top: 2px; }
.status-orb { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 4px var(--green-soft); }
.shortcut-row { display: flex; align-items: center; justify-content: space-between; border: 0; border-radius: 8px; padding: 8px; background: transparent; color: var(--muted); cursor: pointer; font-size: 10px; }.shortcut-row:hover { background: rgba(127,130,140,.09); color: var(--text); }
kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 25px; height: 20px; padding: 0 5px; border: 1px solid var(--line-strong); border-radius: 5px; background: rgba(127,130,140,.08); box-shadow: 0 1px 0 rgba(0,0,0,.06); color: var(--muted); font-size: 9px; font-family: inherit; }
.workspace { min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.toolbar { height: 58px; flex: 0 0 58px; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 18px 0 22px; border-bottom: 1px solid var(--line); background: var(--toolbar); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); }
.toolbar-title { min-width: 0; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; }.toolbar-title strong { color: var(--text); overflow: hidden; text-overflow: ellipsis; }.toolbar-separator { color: var(--line-strong); }
.toolbar-actions { display: flex; align-items: center; gap: 7px; }
.toolbar-button, .icon-button { height: 31px; border: 1px solid var(--line); border-radius: 8px; background: rgba(127,130,140,.06); cursor: pointer; }.toolbar-button:hover,.icon-button:hover { border-color: var(--line-strong); background: rgba(127,130,140,.12); }
.toolbar-button { display: flex; align-items: center; gap: 16px; padding: 0 7px 0 10px; color: var(--text-secondary); font-size: 10px; }.icon-button { display: grid; place-items: center; width: 31px; padding: 0; font-size: 15px; }
.content { flex: 1; min-height: 0; overflow-y: auto; padding: 35px clamp(24px, 3.3vw, 52px) 54px; scroll-behavior: smooth; }
.workspace-view { display: none; max-width: 1380px; margin: 0 auto; animation: view-in .2s ease both; }.workspace-view.active { display: block; }
@keyframes view-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.hero, .section-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 24px; }
.hero h1, .section-heading h1 { margin: 2px 0 6px; font-size: clamp(28px, 3.2vw, 42px); line-height: 1.02; letter-spacing: -.045em; font-weight: 720; }.section-heading h1 { font-size: clamp(26px, 2.7vw, 36px); }
.section-heading p:not(.eyebrow) { max-width: 680px; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.eyebrow { margin: 0 0 7px; color: var(--accent); font-size: 9px; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
.muted { color: var(--muted); font-size: 11px; }.path { max-width: 730px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hero-meta { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 9px; white-space: nowrap; }.hero-divider { width: 1px; height: 12px; background: var(--line-strong); }
.panel { min-width: 0; border: 1px solid var(--line); border-radius: 14px; padding: 19px; background: var(--panel); box-shadow: var(--shadow-panel); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
.panel-head, .dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.panel-head { margin-bottom: 15px; }.panel h2, .dialog-head h2 { margin: 0; font-size: 15px; letter-spacing: -.015em; font-weight: 670; }.panel-head .muted { display: block; margin-top: 3px; }
.onboarding { display: grid; grid-template-columns: auto 1fr auto; gap: 17px; align-items: center; margin-bottom: 13px; overflow: hidden; position: relative; }
.onboarding:after { content: ""; position: absolute; right: -75px; top: -100px; width: 230px; height: 230px; border-radius: 50%; background: radial-gradient(circle, var(--accent-soft), transparent 66%); pointer-events: none; }
.progress-ring { --progress: 0deg; display: grid; place-items: center; width: 53px; height: 53px; border-radius: 50%; background: conic-gradient(var(--accent) var(--progress), var(--line) 0); position: relative; }.progress-ring:after { content: ""; position: absolute; inset: 5px; border-radius: 50%; background: var(--panel-solid); }.progress-ring strong { position: relative; z-index: 1; font-size: 11px; }
.onboarding-copy h2 { margin: 0 0 4px; font-size: 14px; }.onboarding-copy p { margin: 0; color: var(--muted); font-size: 10px; }.setup-steps { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }.setup-step { display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border-radius: 99px; background: var(--panel-soft); color: var(--muted); font-size: 9px; }.setup-step.done { color: var(--green); background: var(--green-soft); }.setup-step i { display: grid; place-items: center; width: 13px; height: 13px; border: 1px solid currentColor; border-radius: 50%; font-style: normal; font-size: 8px; }
.onboarding-actions { z-index: 1; display: flex; gap: 7px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 13px; margin-bottom: 13px; }
.stat { min-width: 0; border: 1px solid var(--line); border-radius: 13px; background: var(--panel); padding: 15px 16px; box-shadow: var(--shadow-panel); }.stat-top { display: flex; align-items: center; justify-content: space-between; }.stat-icon { display: grid; place-items: center; width: 27px; height: 27px; border-radius: 8px; color: var(--accent); background: var(--accent-soft); font-size: 13px; }.stat-label { color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }.stat strong { display: block; margin-top: 10px; font-size: 23px; line-height: 1; letter-spacing: -.04em; }.stat small { display: block; margin-top: 6px; color: var(--muted); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dashboard-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 13px; margin-top: 13px; }.span-4 { grid-column: span 4; }.span-5 { grid-column: span 5; }.span-7 { grid-column: span 7; }.span-8 { grid-column: span 8; }
.text-button { border: 0; padding: 4px 0; background: transparent; color: var(--accent); font-size: 10px; font-weight: 600; cursor: pointer; }.text-button:hover { color: var(--accent-hover); }
.capability-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin-top: 13px; padding: 14px 0; }.capability-strip > div { display: grid; grid-template-columns: 36px 1fr; column-gap: 9px; padding: 5px 18px; }.capability-strip > div + div { border-left: 1px solid var(--line); }.capability-strip strong,.capability-strip small { display: block; grid-column: 2; }.capability-strip strong { align-self: end; font-size: 11px; }.capability-strip small { margin-top: 2px; color: var(--muted); font-size: 9px; }.capability-icon { grid-row: span 2; align-self: center; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; background: var(--accent-soft); color: var(--accent); font-size: 15px; }
.action { min-height: 31px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--line-strong); border-radius: 8px; padding: 0 11px; background: var(--panel-soft); color: var(--text); cursor: pointer; font-size: 10px; font-weight: 630; white-space: nowrap; transition: transform .12s ease, background .12s ease, border-color .12s ease; }.action:hover { border-color: var(--line-strong); background: rgba(127,130,140,.13); }.action:active { transform: scale(.98); }.action:disabled { cursor: wait; opacity: .55; }.action.primary { border-color: rgba(25,70,185,.28); background: var(--accent); color: white; box-shadow: 0 3px 10px rgba(53,109,243,.2); }.action.primary:hover { background: var(--accent-hover); }.action.secondary { background: var(--panel-soft); }.action.danger { color: var(--red); }.action.danger:hover { border-color: var(--red); background: var(--red-soft); }.action.full { width: 100%; }
.pill, .feature-badge, .live-label, .security-score { display: inline-flex; align-items: center; gap: 6px; border-radius: 99px; padding: 5px 8px; font-size: 9px; font-weight: 650; white-space: nowrap; }.pill { color: var(--green); background: var(--green-soft); }.pill.warning { color: var(--amber); background: var(--amber-soft); }.pill.error { color: var(--red); background: var(--red-soft); }.pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent); }.feature-badge { color: var(--purple); background: color-mix(in srgb, var(--purple) 12%, transparent); text-transform: uppercase; letter-spacing: .05em; }.live-label { color: var(--green); background: var(--green-soft); }.security-score { color: var(--green); background: var(--green-soft); }
.instance-list { display: grid; gap: 9px; }.instance { border: 1px solid var(--line); border-radius: 12px; background: color-mix(in srgb, var(--panel-solid) 56%, transparent); padding: 14px; transition: border-color .15s ease, transform .15s ease; }.instance:hover { border-color: var(--line-strong); transform: translateY(-1px); }.instance-top { display: flex; justify-content: space-between; gap: 14px; }.instance-title { display: flex; align-items: center; gap: 9px; }.branch-icon { display: grid; place-items: center; width: 29px; height: 29px; flex: 0 0 auto; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 13px; }.instance h3 { margin: 0 0 3px; font-size: 12px; }.instance-meta { max-width: 670px; color: var(--muted); font-size: 9px; overflow-wrap: anywhere; }.services,.endpoints,.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }.service { padding: 4px 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-soft); color: var(--muted); font-size: 9px; }.service.running { color: var(--green); }.service.exited,.service.dead { color: var(--red); }.endpoint { display: inline-flex; cursor: pointer; border-radius: 6px; padding: 4px 6px; background: var(--accent-soft); color: var(--accent); font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 8px; transition: background .15s ease; }.endpoint:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.compact-list { display: grid; gap: 1px; }.compact-instance { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; padding: 10px 2px; border-bottom: 1px solid var(--line); }.compact-instance:last-child { border-bottom: 0; }.compact-instance strong,.compact-instance small { display: block; }.compact-instance strong { font-size: 10px; }.compact-instance small { max-width: 460px; margin-top: 3px; color: var(--muted); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { display: grid; justify-items: center; gap: 7px; padding: 32px 14px; text-align: center; }.empty-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; background: var(--accent-soft); color: var(--accent); font-size: 18px; }.empty strong { font-size: 12px; }.empty p { max-width: 430px; margin: 0; color: var(--muted); font-size: 10px; line-height: 1.5; }.empty-actions { display: flex; gap: 7px; margin-top: 5px; }
.table-wrap { width: 100%; overflow: auto; }.table { width: 100%; border-collapse: collapse; }.table th,.table td { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; font-size: 9px; white-space: nowrap; }.table th { color: var(--muted); font-size: 8px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }.table td:first-child strong { font-size: 10px; }.table tbody tr { transition: background .15s ease; }.table tbody tr:hover { background: rgba(127,130,140,.055); }.table .actions { margin: 0; justify-content: flex-end; }
.timeline { max-height: 460px; overflow: auto; padding: 2px 3px 0 5px; }.timeline.compact { max-height: 288px; }.event { position: relative; margin-left: 4px; padding: 0 0 14px 17px; border-left: 1px solid var(--line-strong); }.event:last-child { padding-bottom: 1px; }.event:before { content: ""; position: absolute; left: -4px; top: 3px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }.event.error:before { background: var(--red); box-shadow: 0 0 0 3px var(--red-soft); }.event.warning:before { background: var(--amber); box-shadow: 0 0 0 3px var(--amber-soft); }.event strong { font-size: 10px; }.event p { margin: 3px 0; color: var(--muted); font-size: 9px; line-height: 1.4; }.event time { color: var(--muted); font-size: 8px; }.activity-timeline { max-height: none; }
.filter-head > div:first-child { min-width: 0; }.search-wrap { width: min(260px, 42%); display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); padding: 0 9px; color: var(--muted); }.filter-input { width: 100%; height: 31px; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 10px; }.filter-input::placeholder,input::placeholder { color: var(--muted); opacity: .75; }
.field { display: grid; gap: 5px; min-width: 0; }.field > span { color: var(--text-secondary); font-size: 9px; font-weight: 600; }.field em { color: var(--muted); font-size: 8px; font-style: normal; font-weight: 400; }.field small { color: var(--muted); font-size: 8px; line-height: 1.4; }.field input,.field select,.command-search input { width: 100%; height: 34px; border: 1px solid var(--line); border-radius: 8px; padding: 0 10px; outline: 0; background: var(--field); color: var(--text); font-size: 10px; }.field input:focus,.field select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }.stack-form { display: grid; gap: 10px; margin-top: 15px; }.two-up,.remote-operation-form { grid-template-columns: repeat(2, minmax(0,1fr)); }.nested-fields { display: grid; gap: 10px; margin-top: 10px; }.full-span { grid-column: 1 / -1; }.remote-operation-form { display: grid; gap: 10px; margin-top: 15px; align-items: end; }.check-field { min-height: 34px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; background: var(--field); color: var(--text-secondary); font-size: 9px; }.check-field input,.check-card input { accent-color: var(--accent); }.form-divider { display: flex; align-items: center; gap: 8px; margin: 17px 0 4px; color: var(--muted); font-size: 8px; text-transform: uppercase; }.form-divider:before,.form-divider:after { content: ""; height: 1px; flex: 1; background: var(--line); }.action-panel > .muted { margin: 5px 0 0; line-height: 1.5; }.advanced { margin: 0; padding: 0; border: 0; }.advanced summary { cursor: pointer; color: var(--accent); font-size: 9px; font-weight: 600; }
.security-row { display: flex; align-items: center; justify-content: space-between; gap: 15px; padding: 10px 1px; border-bottom: 1px solid var(--line); font-size: 10px; }.security-row:last-child { border-bottom: 0; }.security-row span { color: var(--muted); }.security-row strong { text-align: right; }.shield { display: grid; place-items: center; width: 31px; height: 31px; border-radius: 9px; background: var(--green-soft); color: var(--green); font-size: 17px; }.secret-summary { margin: 0; }.security-callout { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 14px; margin-top: 13px; }.callout-icon { display: grid; place-items: center; width: 35px; height: 35px; border-radius: 10px; background: var(--green-soft); color: var(--green); font-weight: 800; }.security-callout strong { font-size: 11px; }.security-callout p { margin: 3px 0 0; color: var(--muted); font-size: 9px; line-height: 1.45; }
dialog { color: var(--text); background: var(--panel-solid); border: 1px solid var(--line-strong); border-radius: 15px; box-shadow: var(--shadow-window); }.sheet-dialog { width: min(480px, calc(100vw - 34px)); padding: 21px; }.dialog-head { margin-bottom: 13px; }.dialog-copy { margin: 0; color: var(--muted); font-size: 10px; line-height: 1.55; }.dialog-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 7px; }.dialog-close { font-size: 19px; }.check-card { display: flex; align-items: flex-start; gap: 10px; border: 1px solid var(--line); border-radius: 10px; padding: 11px; background: var(--field); }.check-card input { margin-top: 2px; }.check-card strong,.check-card small { display: block; }.check-card strong { font-size: 10px; }.check-card small { margin-top: 3px; color: var(--muted); font-size: 8px; }
dialog::backdrop { background: rgba(9, 11, 16, .46); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }.logs-dialog { width: min(1000px, calc(100vw - 40px)); height: min(720px, calc(100vh - 48px)); padding: 18px; }.logs-dialog pre { height: calc(100% - 51px); overflow: auto; margin: 0; border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: #111318; color: #e8ecf4; font: 10px/1.55 ui-monospace, "SFMono-Regular", Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
.command-dialog { width: min(580px, calc(100vw - 34px)); padding: 9px; transform: translateY(-10vh); }.command-search { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); padding: 4px 7px 11px; color: var(--muted); }.command-search input { flex: 1; border: 0; background: transparent; font-size: 13px; }.command-list { display: grid; gap: 2px; max-height: 390px; overflow: auto; padding-top: 7px; }.command-list button { display: grid; grid-template-columns: 32px 1fr auto; align-items: center; gap: 10px; width: 100%; border: 0; border-radius: 9px; padding: 9px; background: transparent; text-align: left; cursor: pointer; }.command-list button:hover,.command-list button.selected { background: var(--accent-soft); }.command-list strong,.command-list small { display: block; }.command-list strong { font-size: 10px; }.command-list small { margin-top: 3px; color: var(--muted); font-size: 8px; }.command-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: var(--panel-soft); color: var(--accent); font-size: 14px; }
#toast { position: fixed; right: 32px; bottom: 31px; z-index: 100; max-width: 420px; padding: 11px 14px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--panel-solid); box-shadow: var(--shadow-window); color: var(--text); font-size: 10px; opacity: 0; transform: translateY(70px); transition: .22s ease; pointer-events: none; }.desktop-shell.hidden + dialog + dialog + dialog + #toast { display: none; }#toast.show { opacity: 1; transform: none; }
.locked { min-height: 100vh; display: grid; place-items: center; padding: 30px; }.locked-card { width: min(440px, 100%); border: 1px solid var(--line); border-radius: 18px; padding: 38px; background: var(--panel); box-shadow: var(--shadow-window); text-align: center; }.locked h1 { margin: 4px 0 8px; font-size: 25px; letter-spacing: -.03em; }.locked p:not(.eyebrow) { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }.locked code { color: var(--accent); }
.skeleton-block:empty { min-height: 70px; border-radius: 10px; background: linear-gradient(100deg, var(--panel-soft) 20%, rgba(127,130,140,.12) 38%, var(--panel-soft) 55%); background-size: 200% 100%; animation: skeleton 1.25s infinite; }.onboarding.skeleton-block:empty { min-height: 84px; }.instance-list.skeleton-block:empty { min-height: 190px; }@keyframes skeleton { to { background-position-x: -200%; } }
@media (max-width: 1050px) { .desktop-shell { grid-template-columns: 205px minmax(0,1fr); }.span-7,.span-5,.span-8,.span-4 { grid-column: 1 / -1; }.state-grid,.remote-grid { gap: 13px; }.toolbar-button { display: none; }.onboarding { grid-template-columns: auto 1fr; }.onboarding-actions { grid-column: 1 / -1; padding-left: 70px; }.security-callout { grid-template-columns: auto 1fr; }.security-callout .action { grid-column: 2; justify-self: start; } }
@media (max-width: 760px) { .desktop-shell { inset: 0; grid-template-columns: 1fr; border: 0; border-radius: 0; }.sidebar { z-index: 20; position: fixed; bottom: 0; left: 0; right: 0; height: 59px; display: block; padding: 5px 6px; border: 1px solid var(--line); border-width: 1px 0 0; background: var(--toolbar); -webkit-backdrop-filter: blur(25px); backdrop-filter: blur(25px); }.window-controls,.brand,.sidebar-footer { display: none; }.navigation { display: grid; grid-template-columns: repeat(6,1fr); gap: 2px; }.nav-item { height: 48px; display: flex; flex-direction: column; justify-content: center; gap: 2px; padding: 0; font-size: 8px; text-align: center; }.nav-icon { font-size: 14px; }.nav-count { display: none; }.workspace { padding-bottom: 58px; }.toolbar { padding: 0 12px; }.toolbar-title { display: none; }.toolbar-actions { width: 100%; justify-content: flex-end; }.toolbar-actions .action.primary { margin-left: auto; }.content { padding: 26px 14px 38px; }.hero,.section-heading { align-items: flex-start; flex-direction: column; gap: 12px; }.hero-meta { white-space: normal; flex-wrap: wrap; }.stats { grid-template-columns: repeat(2,1fr); }.capability-strip { grid-template-columns: 1fr; }.capability-strip > div + div { border-left: 0; border-top: 1px solid var(--line); }.filter-head { align-items: stretch; flex-direction: column; }.search-wrap { width: 100%; }.two-up,.remote-operation-form { grid-template-columns: 1fr; }.full-span { grid-column: auto; }.security-callout { grid-template-columns: 1fr; }.security-callout .action { grid-column: auto; }.onboarding { grid-template-columns: 1fr; justify-items: start; }.onboarding-actions { grid-column: auto; padding-left: 0; flex-wrap: wrap; }.progress-ring { width: 46px; height: 46px; }.table th,.table td { padding: 9px 7px; }.toolbar-actions #connection { margin-right: auto; } }
@media (max-width: 430px) { .stats { grid-template-columns: 1fr; }.toolbar-actions #theme-toggle { display: none; }.toolbar-actions .action.primary { padding: 0 8px; }.instance-top { flex-direction: column; }.empty-actions { flex-direction: column; }.panel { padding: 15px; } }
@media (prefers-reduced-motion: reduce) { *, *:before, *:after { scroll-behavior: auto !important; animation-duration: .01ms !important; transition-duration: .01ms !important; } }`;

const javascript = String.raw`(() => {
  const tokenFromHash = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '';
  if (tokenFromHash) {
    sessionStorage.setItem('branchlift-token', tokenFromHash);
    history.replaceState(null, '', location.pathname);
  }
  const token = sessionStorage.getItem('branchlift-token') || '';
  const app = document.getElementById('app');
  const locked = document.getElementById('locked');
  if (!token) { locked.classList.remove('hidden'); return; }
  app.classList.remove('hidden');

  const headers = { Authorization: 'Bearer ' + token };
  const byId = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
  const bytes = value => {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let index = 0; let size = Number(value || 0);
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
    return (size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[index];
  };
  const ago = value => {
    const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) return 'unknown';
    const duration = Math.max(0, Date.now() - timestamp);
    if (duration < 60000) return Math.floor(duration / 1000) + 's ago';
    if (duration < 3600000) return Math.floor(duration / 60000) + 'm ago';
    if (duration < 86400000) return Math.floor(duration / 3600000) + 'h ago';
    return Math.floor(duration / 86400000) + 'd ago';
  };
  const healthyInstance = instance => instance.status === 'running' && (instance.services || []).every(service => service.state === 'running' && (!service.health || service.health === 'healthy'));

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({ error: 'Invalid response' }));
    if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
    return body;
  }

  let toastTimer;
  function toast(message, error = false) {
    const element = byId('toast'); clearTimeout(toastTimer); element.textContent = message;
    element.style.borderColor = error ? 'var(--red)' : 'var(--line-strong)'; element.classList.add('show');
    toastTimer = setTimeout(() => element.classList.remove('show'), 3600);
  }

  function setButtonBusy(button, busy, label) {
    if (busy) { button.dataset.originalLabel = button.innerHTML; button.disabled = true; button.textContent = label || 'Working…'; }
    else { button.disabled = false; if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel; delete button.dataset.originalLabel; }
  }

  function emptyMarkup(icon, title, copy, actions) {
    return '<div class="empty"><span class="empty-icon">' + icon + '</span><strong>' + esc(title) + '</strong><p>' + esc(copy) + '</p>' + (actions ? '<div class="empty-actions">' + actions + '</div>' : '') + '</div>';
  }

  function statusClass(status) { return status === 'failed' ? 'error' : status === 'running' ? '' : 'warning'; }
  function instanceMarkup(instance) {
    const services = (instance.services || []).map(service => '<span class="service ' + esc(service.state) + '">' + esc(service.service) + ' · ' + esc(service.health || service.state) + '</span>').join('');
    const endpoints = (instance.endpoints || []).map(endpoint => '<button class="endpoint" data-endpoint="' + esc(endpoint.url) + '" title="Copy endpoint">' + esc(endpoint.service) + ': ' + esc(endpoint.url) + '</button>').join('');
    const lifecycle = instance.status === 'running'
      ? '<button class="action secondary" data-action="stop" data-branch="' + esc(instance.branch) + '">Stop</button>'
      : '<button class="action secondary" data-action="start" data-branch="' + esc(instance.branch) + '">Start</button>';
    return '<article class="instance"><div class="instance-top"><div class="instance-title"><span class="branch-icon">⌘</span><div><h3>' + esc(instance.branch) + '</h3><div class="instance-meta">' + esc(instance.snapshot) + ' · ' + esc(instance.worktreePath) + '</div></div></div><span class="pill ' + statusClass(instance.status) + '"><span class="pulse"></span>' + esc(instance.status) + '</span></div>' + (services ? '<div class="services">' + services + '</div>' : '') + (endpoints ? '<div class="endpoints">' + endpoints + '</div>' : '') + '<div class="actions"><button class="action secondary" data-action="logs" data-branch="' + esc(instance.branch) + '">Logs</button>' + lifecycle + '<button class="action secondary" data-action="reset" data-branch="' + esc(instance.branch) + '">Reset</button><button class="action danger" data-action="destroy" data-branch="' + esc(instance.branch) + '">Destroy</button></div></article>';
  }

  function eventMarkup(event) {
    return '<div class="event ' + esc(event.level) + '"><strong>' + esc(event.kind) + '</strong><p>' + esc(event.message) + '</p><time>' + esc(ago(event.timestamp)) + '</time></div>';
  }

  function renderOnboarding(data) {
    const steps = [
      { name: 'Policy reviewed', done: data.policy.trusted },
      { name: 'Golden snapshot', done: data.snapshots.length > 0 },
      { name: 'First environment', done: data.instances.length > 0 },
    ];
    const complete = steps.filter(step => step.done).length;
    const progress = Math.round((complete / steps.length) * 100);
    let action = '<button class="action primary" data-nav="activity">Watch live state →</button>';
    let title = 'Ready for parallel agents';
    let copy = 'Your project has an approved policy, immutable state, and at least one isolated environment.';
    if (!data.policy.trusted) {
      title = 'Review the project security policy'; copy = 'Trust is machine-local and digest-bound, so policy changes require review again.';
      action = '<button class="copy-command action primary" data-copy="branchlift security trust">Copy trust command</button>';
    } else if (!data.snapshots.length) {
      title = 'Create the golden backend state'; copy = 'Build or import one stopped-consistent snapshot, then clone it for every branch.';
      action = '<button class="copy-command action primary" data-copy="branchlift snapshot dev">Copy snapshot command</button>';
    } else if (!data.instances.length) {
      title = 'Launch your first isolated branch'; copy = 'One environment proves the complete worktree, volume, network, and port lifecycle.';
      action = '<button class="action primary" data-open-spawn>Create environment</button>';
    }
    const remoteStep = '<span class="setup-step ' + (data.remotes.length ? 'done' : '') + '"><i>' + (data.remotes.length ? '✓' : '＋') + '</i> Remote host <small>(optional)</small></span>';
    byId('onboarding').classList.remove('skeleton-block');
    byId('onboarding').innerHTML = '<div class="progress-ring" style="--progress:' + (progress * 3.6) + 'deg"><strong>' + progress + '%</strong></div><div class="onboarding-copy"><h2>' + esc(title) + '</h2><p>' + esc(copy) + '</p><div class="setup-steps">' + steps.map(step => '<span class="setup-step ' + (step.done ? 'done' : '') + '"><i>' + (step.done ? '✓' : '·') + '</i>' + esc(step.name) + '</span>').join('') + remoteStep + '</div></div><div class="onboarding-actions">' + action + '<button class="action secondary" data-nav="security">Inspect posture</button></div>';
  }

  function renderStats(data) {
    const running = data.instances.filter(instance => instance.status === 'running').length;
    const healthy = data.instances.filter(healthyInstance).length;
    const cards = [
      { label: 'Running', value: running, detail: data.instances.length + ' total environments', icon: '⌘' },
      { label: 'Healthy stacks', value: healthy + '/' + data.instances.length, detail: data.instances.length ? 'service health verified' : 'waiting for first runtime', icon: '✓' },
      { label: 'Snapshots', value: data.snapshots.length, detail: 'immutable restore points', icon: '◫' },
      { label: 'SSH workers', value: data.remotes.length, detail: 'machines you control', icon: '↗' },
    ];
    byId('stats').innerHTML = cards.map(card => '<article class="stat"><div class="stat-top"><span class="stat-label">' + esc(card.label) + '</span><span class="stat-icon">' + card.icon + '</span></div><strong>' + esc(card.value) + '</strong><small>' + esc(card.detail) + '</small></article>').join('');
  }

  function renderInstances(data) {
    byId('nav-instance-count').textContent = String(data.instances.length);
    const running = data.instances.filter(instance => instance.status === 'running').length;
    byId('environment-summary').textContent = running + ' running · ' + data.instances.length + ' total';
    byId('instances').classList.remove('skeleton-block');
    byId('instances').innerHTML = data.instances.length ? data.instances.map(instanceMarkup).join('') : emptyMarkup('⌘', 'No isolated environments yet', 'Create one from a golden snapshot. BranchLift assigns an isolated worktree, backend volumes, network, and ports.', '<button class="action primary" data-open-spawn>Create environment</button><button class="copy-command action secondary" data-copy="branchlift spawn feature/my-branch">Copy CLI command</button>');
    byId('overview-instances').classList.remove('skeleton-block');
    byId('overview-instances').innerHTML = data.instances.length ? data.instances.slice(0, 5).map(instance => '<div class="compact-instance"><div><strong>' + esc(instance.branch) + '</strong><small>' + esc(instance.snapshot) + ' · ' + esc((instance.services || []).length) + ' services · ' + esc((instance.endpoints || []).length) + ' endpoints</small></div><span class="pill ' + statusClass(instance.status) + '"><span class="pulse"></span>' + esc(instance.status) + '</span></div>').join('') : emptyMarkup('＋', 'Start with one branch', 'Clone known backend state instead of re-running migrations and seeds.', '<button class="action primary" data-open-spawn>New environment</button>');
  }

  function renderSnapshots(data) {
    byId('snapshots').classList.remove('skeleton-block');
    byId('snapshots').innerHTML = data.snapshots.length
      ? '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Parent</th><th>Size</th><th>Content digest</th><th>Created</th></tr></thead><tbody>' + data.snapshots.map(snapshot => '<tr><td><strong>' + esc(snapshot.name) + '</strong></td><td>' + esc(snapshot.parentSnapshot || 'root') + '</td><td>' + esc(bytes(snapshot.sizeBytes)) + '</td><td><code>' + esc(snapshot.contentDigest ? snapshot.contentDigest.slice(0, 12) : 'not indexed') + '</code></td><td>' + esc(ago(snapshot.createdAt)) + '</td></tr>').join('') + '</tbody></table></div>'
      : emptyMarkup('◫', 'No immutable snapshots yet', 'Create a stopped-consistent golden backend once, then every agent can branch from it.', '<button class="copy-command action primary" data-copy="branchlift snapshot dev">Copy snapshot command</button>');
  }

  function renderSecurity(data) {
    const security = data.security;
    const checks = [data.policy.trusted, security.boundary === 'container', security.readOnlyRoot, !security.hostDockerSocketMounted, security.capabilities === 'dropped'];
    const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
    byId('security-score').textContent = score + '% posture checks';
    byId('security-score').style.color = score === 100 ? 'var(--green)' : 'var(--amber)';
    byId('security').classList.remove('skeleton-block');
    byId('security').innerHTML = [
      ['Project policy', data.policy.trusted ? 'trusted' : 'approval required'], ['Boundary', security.boundary], ['Backend', security.backend], ['Network', security.network],
      ['Root filesystem', security.readOnlyRoot ? 'read-only' : 'writable'], ['Linux capabilities', security.capabilities], ['Host Docker socket', security.hostDockerSocketMounted ? 'mounted' : 'not mounted'],
      ['Resource limits', security.resourceLimits.memory + ' · ' + security.resourceLimits.cpus + ' CPU · ' + security.resourceLimits.pids + ' PIDs'],
    ].map(row => '<div class="security-row"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong></div>').join('');
    byId('secrets').classList.remove('skeleton-block');
    byId('secrets').innerHTML = '<div class="secret-summary">' + (data.secrets.length ? data.secrets.map(secret => '<div class="security-row"><span>' + esc(secret.name) + ' → ' + esc(secret.target) + '</span><strong style="color:' + (secret.available ? 'var(--green)' : secret.required ? 'var(--red)' : 'var(--muted)') + '">' + (secret.available ? 'available' : secret.required ? 'missing' : 'optional') + '</strong></div>').join('') : emptyMarkup('◇', 'No scoped secrets configured', 'Secrets stay outside worktrees and are injected only into an allowed command scope.', '<button class="copy-command action secondary" data-copy="branchlift security inspect">Inspect policy</button>')) + '</div>';
  }

  function renderEvents(data) {
    byId('events').classList.remove('skeleton-block'); byId('overview-events').classList.remove('skeleton-block');
    byId('events').innerHTML = data.events.length ? data.events.map(eventMarkup).join('') : emptyMarkup('≋', 'No audit events yet', 'Lifecycle and security operations will appear here as they happen.', '');
    byId('overview-events').innerHTML = data.events.length ? data.events.slice(0, 6).map(eventMarkup).join('') : emptyMarkup('≋', 'Waiting for activity', 'Create an environment or inspect security to start the local trail.', '');
  }

  function renderRemotes(data) {
    byId('remotes').classList.remove('skeleton-block');
    byId('remotes').innerHTML = data.remotes.length
      ? '<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Target</th><th>Repository</th><th>Worker</th><th></th></tr></thead><tbody>' + data.remotes.map(remote => '<tr><td><strong>' + esc(remote.name) + '</strong></td><td>' + esc((remote.user ? remote.user + '@' : '') + remote.host + ':' + remote.port) + '</td><td>' + esc(remote.repoPath) + '</td><td>' + esc(remote.managedBinary ? 'managed ' + (remote.lastSetupAt ? '· ' + ago(remote.lastSetupAt) : '') : 'external / unverified') + '</td><td><div class="actions"><button class="action secondary" data-remote-action="ping" data-remote="' + esc(remote.name) + '">Ping</button><button class="action secondary" data-remote-action="setup" data-remote="' + esc(remote.name) + '">Setup</button><button class="action danger" data-remote-action="remove" data-remote="' + esc(remote.name) + '">Remove</button></div></td></tr>').join('') + '</tbody></table></div>'
      : emptyMarkup('↗', 'No SSH workers connected', 'Add any machine you control. BranchLift uses strict-host-key SSH and has no public daemon or hosted relay.', '<button class="copy-command action secondary" data-copy="branchlift remote add lab --host HOST --repo-path /absolute/path">Copy CLI example</button>');
  }

  function render(data) {
    byId('repo-name').textContent = data.repository.name; byId('repo-root').textContent = data.repository.root;
    byId('toolbar-repo').textContent = data.repository.name; byId('generated').textContent = 'Updated ' + ago(data.generatedAt);
    renderOnboarding(data); renderStats(data); renderInstances(data); renderSnapshots(data); renderSecurity(data); renderEvents(data); renderRemotes(data);
    const connection = byId('connection'); connection.innerHTML = '<span class="pulse"></span>Live'; connection.className = 'pill';
  }

  const viewNames = { overview: 'Overview', environments: 'Environments', state: 'State', security: 'Security', remotes: 'Remotes', activity: 'Activity' };
  function setView(view) {
    const selected = viewNames[view] ? view : 'overview';
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === selected));
    document.querySelectorAll('[data-view-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.viewPanel === selected));
    byId('toolbar-section').textContent = viewNames[selected];
    try { localStorage.setItem('branchlift-view', selected); } catch {}
    document.querySelector('.content').scrollTop = 0;
  }

  function openDialog(id) {
    const dialog = byId(id); if (!dialog.open) dialog.showModal();
  }

  async function copyText(value) {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      else {
        const temporary = document.createElement('textarea'); temporary.value = value; temporary.style.position = 'fixed'; temporary.style.opacity = '0';
        document.body.appendChild(temporary); temporary.select(); document.execCommand('copy'); temporary.remove();
      }
      toast('Copied: ' + value);
    } catch { toast('Could not copy to clipboard', true); }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('branchlift-theme', theme); } catch {}
    byId('theme-toggle').textContent = theme === 'dark' ? '☀' : '◐';
  }
  let savedTheme = '';
  try { savedTheme = localStorage.getItem('branchlift-theme') || ''; } catch {}
  if (savedTheme === 'dark' || savedTheme === 'light') applyTheme(savedTheme);

  let loading = false;
  async function load() {
    if (loading) return; loading = true; byId('refresh').disabled = true;
    try { render(await api('/api/state')); applyFilters(); }
    catch (error) { const connection = byId('connection'); connection.innerHTML = '<span class="pulse"></span>Disconnected'; connection.className = 'pill error'; toast(error.message, true); }
    finally { loading = false; byId('refresh').disabled = false; }
  }

  function updateRemoteFields() {
    const operation = byId('remote-operation').value;
    document.querySelectorAll('.remote-field').forEach(wrapper => {
      const visible = (wrapper.dataset.ops || '').split(',').includes(operation);
      wrapper.classList.toggle('hidden', !visible);
      wrapper.querySelectorAll('input,select').forEach(control => { control.disabled = !visible; });
    });
  }

  const applyFilters = () => {
    const query = id => ((byId(id) || {}).value || '').trim().toLowerCase();
    const match = (element, term) => !term || element.textContent.toLowerCase().includes(term);
    document.querySelectorAll('#instances .instance').forEach(element => { element.style.display = match(element, query('instance-filter')) ? '' : 'none'; });
    document.querySelectorAll('#snapshots tbody tr').forEach(element => { element.style.display = match(element, query('snapshot-filter')) ? '' : 'none'; });
    document.querySelectorAll('#events .event').forEach(element => { element.style.display = match(element, query('event-filter')) ? '' : 'none'; });
  };

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  ['instance-filter', 'snapshot-filter', 'event-filter'].forEach(id => byId(id).addEventListener('input', applyFilters));
  byId('refresh').addEventListener('click', load);
  byId('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
  byId('remote-operation').addEventListener('change', updateRemoteFields); updateRemoteFields();
  byId('close-logs').addEventListener('click', () => byId('logs-dialog').close());
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => byId(button.dataset.closeDialog).close()));

  app.addEventListener('click', event => {
    const spawn = event.target.closest('[data-open-spawn]'); if (spawn) { openDialog('spawn-dialog'); setTimeout(() => byId('spawn-form').elements.branch.focus(), 30); return; }
    const navigation = event.target.closest('[data-nav]'); if (navigation) { setView(navigation.dataset.nav); return; }
    const copy = event.target.closest('[data-copy]'); if (copy) { copyText(copy.dataset.copy); return; }
    const endpoint = event.target.closest('.endpoint'); if (endpoint) copyText(endpoint.dataset.endpoint || '');
  });

  byId('instances').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const action = button.dataset.action; const branch = button.dataset.branch; setButtonBusy(button, true, action === 'logs' ? 'Loading…' : 'Working…');
    try {
      if (action === 'logs') {
        const result = await api('/api/logs?branch=' + encodeURIComponent(branch)); byId('logs-title').textContent = branch + ' logs'; byId('logs-output').textContent = result.logs || 'No logs.'; openDialog('logs-dialog'); return;
      }
      let confirmValue;
      if (action === 'reset' || action === 'destroy') { if (!confirm(action + ' ' + branch + '?')) return; confirmValue = branch; }
      await api('/api/actions/' + action, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ branch, confirm: confirmValue }) });
      toast(action + ' completed for ' + branch); await load();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  byId('remotes').addEventListener('click', async event => {
    const button = event.target.closest('button[data-remote-action]'); if (!button) return;
    const action = button.dataset.remoteAction; const name = button.dataset.remote; setButtonBusy(button, true, 'Working…');
    try {
      if (action === 'remove' && !confirm('Remove remote ' + name + '?')) return;
      const result = await api('/api/actions/remote-' + action, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ name, confirm: action === 'remove' ? name : undefined }) });
      toast(action === 'ping' ? 'Remote ' + name + ' reachable (' + result.latencyMs + ' ms)' : action === 'setup' ? 'Remote ' + name + ' worker installed and verified' : 'Remote ' + name + ' removed'); await load();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  byId('remote-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); const values = Object.fromEntries(new FormData(form).entries());
    setButtonBusy(button, true, 'Adding remote…');
    try {
      if (values.port) values.port = Number(values.port); Object.keys(values).forEach(key => { if (values[key] === '') delete values[key]; });
      await api('/api/actions/remote-add', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(values) });
      toast('Remote ' + values.name + ' added'); form.reset(); await load();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  byId('remote-operation-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); const values = Object.fromEntries(new FormData(form).entries());
    values.start = form.elements.start.checked; values.trustPolicy = form.elements.trustPolicy.checked; values.noCache = form.elements.noCache.checked;
    Object.keys(values).forEach(key => { if (values[key] === '') delete values[key]; });
    if (['launch','live-sync','tunnel-start','tunnel-status','tunnel-stop','reset','destroy'].includes(values.operation) && !values.branch) { toast('A branch is required', true); return; }
    if (values.operation === 'build' && !values.tag) { toast('An image tag is required for a build', true); return; }
    if (values.operation === 'reset' || values.operation === 'destroy') { if (!confirm(values.operation + ' ' + values.branch + ' on ' + values.name + '?')) return; values.confirm = values.branch; }
    if (values.operation === 'cache-prune') { if (!confirm('Prune BranchLift scoped build cache on ' + values.name + '?')) return; values.confirm = 'prune'; }
    setButtonBusy(button, true, 'Running remotely…');
    try {
      const result = await api('/api/actions/remote-operate', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(values) });
      if (['sync','launch','live-sync','tunnel-start','tunnel-status','tunnel-stop','build','cache-inspect','cache-prune','list','snapshots','preview'].includes(values.operation)) {
        byId('logs-title').textContent = values.name + ' · ' + values.operation; byId('logs-output').textContent = JSON.stringify(result.result, null, 2); openDialog('logs-dialog');
      } else toast(values.operation + ' completed on ' + values.name);
      await load();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  byId('spawn-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); const values = Object.fromEntries(new FormData(form).entries()); values.start = form.elements.start.checked;
    if (!values.snapshot) delete values.snapshot; setButtonBusy(button, true, 'Creating environment…');
    try {
      await api('/api/actions/spawn', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(values) });
      toast('Environment ' + values.branch + ' created'); form.reset(); form.elements.start.checked = true; byId('spawn-dialog').close(); setView('environments'); await load();
    } catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  byId('commit-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); const values = Object.fromEntries(new FormData(form).entries()); setButtonBusy(button, true, 'Committing…');
    try { await api('/api/actions/snapshot-commit', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(values) }); toast('Snapshot ' + values.name + ' committed'); form.reset(); await load(); }
    catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  byId('diff-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); const values = Object.fromEntries(new FormData(form).entries()); setButtonBusy(button, true, 'Comparing…');
    try { const result = await api('/api/actions/snapshot-diff', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(values) }); byId('logs-title').textContent = values.left + ' → ' + values.right; byId('logs-output').textContent = JSON.stringify(result.diff, null, 2); openDialog('logs-dialog'); }
    catch (error) { toast(error.message, true); } finally { setButtonBusy(button, false); }
  });

  const commandDialog = byId('command-dialog');
  function openCommandPalette() { openDialog('command-dialog'); byId('command-search').value = ''; filterCommands(); setTimeout(() => byId('command-search').focus(), 25); }
  function filterCommands() { const term = byId('command-search').value.trim().toLowerCase(); byId('command-list').querySelectorAll('button').forEach(button => { button.hidden = term && !button.textContent.toLowerCase().includes(term); }); }
  function runCommand(command) {
    commandDialog.close(); if (command === 'spawn') openDialog('spawn-dialog'); else if (command === 'refresh') load(); else setView(command);
  }
  byId('open-command').addEventListener('click', openCommandPalette); byId('open-command-sidebar').addEventListener('click', openCommandPalette);
  byId('command-search').addEventListener('input', filterCommands);
  byId('command-list').addEventListener('click', event => { const button = event.target.closest('button[data-command]'); if (button) runCommand(button.dataset.command); });
  byId('command-search').addEventListener('keydown', event => { if (event.key === 'Enter') { const first = Array.from(byId('command-list').querySelectorAll('button[data-command]')).find(button => !button.hidden); if (first) runCommand(first.dataset.command); } });

  document.addEventListener('keydown', event => {
    const tag = (document.activeElement || {}).tagName || '';
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); return; }
    if (event.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(tag)) { event.preventDefault(); setView('environments'); setTimeout(() => byId('instance-filter').focus(), 20); }
    if (event.key === 'Escape' && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('filter-input')) { document.activeElement.value = ''; applyFilters(); }
  });

  async function live() {
    try {
      const response = await fetch('/api/events/stream', { headers }); if (!response.ok) throw new Error('stream ' + response.status);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) { const result = await reader.read(); if (result.done) break; buffer += decoder.decode(result.value, { stream: true }); if (buffer.includes('\n\n')) { buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2); load(); } }
    } catch { setTimeout(live, 2500); }
  }

  let initialView = 'overview'; try { initialView = localStorage.getItem('branchlift-view') || 'overview'; } catch {}
  setView(initialView); load(); live(); setInterval(() => { if (!document.hidden) load(); }, 15000);
})();`;
