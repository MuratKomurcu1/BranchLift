import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installAgentIntegrations } from "../src/agents.js";
import type { RepoInfo } from "../src/types.js";

test("installs Codex, Claude, and Cursor hooks plus MCP without replacing existing settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-agents-"));
  const repo = fixtureRepo(root);
  try {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
    const first = await installAgentIntegrations(repo, ["codex", "claude", "cursor"], true);
    assert.equal(first.length, 6);
    assert.ok(first.every(({ changed }) => changed));

    const claude = JSON.parse(await readFile(join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(claude.permissions.allow, ["Bash(npm test)"]);
    assert.match(JSON.stringify(claude.hooks.SessionStart), /branchlift hook attach/);

    const cursor = JSON.parse(await readFile(join(root, ".cursor", "hooks.json"), "utf8"));
    assert.equal(cursor.version, 1);
    assert.match(cursor.hooks.sessionStart[0].command, /--format cursor/);

    const codex = await readFile(join(root, ".codex", "config.toml"), "utf8");
    assert.match(codex, /\[mcp_servers\.branchlift]/);
    assert.match(await readFile(join(root, ".mcp.json"), "utf8"), /"branchlift"/);
    assert.match(await readFile(join(root, ".cursor", "mcp.json"), "utf8"), /"branchlift"/);

    const second = await installAgentIntegrations(repo, ["codex", "claude", "cursor"], true);
    assert.ok(second.every(({ changed }) => !changed));
    assert.equal((await readFile(join(root, ".codex", "config.toml"), "utf8")).match(/\[mcp_servers\.branchlift]/g)?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run reports changes without creating files", async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-agents-dry-"));
  try {
    const results = await installAgentIntegrations(fixtureRepo(root), ["codex"], false);
    assert.ok(results.every(({ changed }) => changed));
    await assert.rejects(readFile(join(root, ".codex", "hooks.json")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureRepo(root: string): RepoInfo {
  return { root, commonDir: join(root, ".git"), name: "fixture", key: "fixture-key" };
}
