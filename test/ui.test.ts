import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startUiServer } from "../src/ui.js";
import type { BranchLiftConfig, RepoInfo } from "../src/types.js";

test("serves a token-protected loopback control plane with strict browser headers", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-ui-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  const config: BranchLiftConfig = {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: [] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles: [] },
  };
  const handle = await startUiServer(repo, config, { port: 0, token: "test-token-that-is-longer-than-thirty-two-characters" });
  const origin = `http://127.0.0.1:${handle.port}`;
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const pageText = await page.text();
    assert.doesNotMatch(pageText, /test-token-that-is-longer/);
    assert.match(pageText, /live sync, tunnels &amp; BuildKit/i);
    assert.match(pageText, /data-view="overview"/);
    assert.match(pageText, /id="onboarding"/);
    assert.match(pageText, /id="command-dialog"/);
    assert.match(pageText, /id="theme-toggle"/);
    assert.match(pageText, /data-ops="build"/);
    const browserCode = await (await fetch(`${origin}/app.js`)).text();
    assert.match(browserCode, /cache-prune/);
    assert.match(browserCode, /tunnel-start/);
    assert.match(browserCode, /applyFilters/);
    assert.match(browserCode, /navigator\.clipboard/);
    assert.match(browserCode, /instance-filter/);
    assert.match(browserCode, /openCommandPalette/);
    assert.match(browserCode, /updateRemoteFields/);
    assert.match(browserCode, /branchlift-theme/);
    assert.match(pageText, /filter-input/);

    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${origin}/api/state`, {
      headers: { Authorization: `Bearer ${handle.token}`, Origin: "https://attacker.example" },
    })).status, 403);

    const stateResponse = await fetch(`${origin}/api/state`, {
      headers: { Authorization: `Bearer ${handle.token}`, Origin: origin },
    });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { repository: { name: string }; instances: unknown[]; security: { boundary: string } };
    assert.equal(state.repository.name, "demo");
    assert.deepEqual(state.instances, []);
    assert.equal(state.security.boundary, "container");
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("refuses non-loopback listeners even for direct module callers", async () => {
  const repo: RepoInfo = { root: "/tmp/demo", commonDir: "/tmp/demo/.git", name: "demo", key: "demo-key" };
  const config: BranchLiftConfig = {
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: [] },
    snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
    worktree: { copyFiles: [] },
  };
  await assert.rejects(startUiServer(repo, config, { host: "0.0.0.0" as "127.0.0.1" }), /only listen on/);
});
