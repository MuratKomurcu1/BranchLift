import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { handleMcpRequest } from "../src/mcp.js";
import type { RepoInfo } from "../src/types.js";

const repo: RepoInfo = { root: "/tmp/branchlift-mcp-fixture", commonDir: "/tmp/branchlift-mcp-fixture/.git", name: "fixture", key: "fixture" };

test("MCP initializes with instructions and exposes the BranchLift tool contract", async () => {
  const initialized = await handleMcpRequest(repo, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal((initialized?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.match((initialized?.result as { instructions: string }).instructions, /branchlift_attach/);

  const listed = await handleMcpRequest(repo, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map(({ name }) => name);
  assert.deepEqual(names, [
    "branchlift_attach",
    "branchlift_list",
    "branchlift_preview",
    "branchlift_logs",
    "branchlift_security",
    "branchlift_snapshots",
    "branchlift_snapshot_diff",
    "branchlift_events",
    "branchlift_remotes",
  ]);
});

test("MCP ignores notifications and returns structured tool errors", async () => {
  assert.equal(await handleMcpRequest(repo, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  const response = await handleMcpRequest(repo, {
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: { name: "missing", arguments: {} },
  });
  assert.equal((response?.result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(response?.result), /Unknown MCP tool/);
});
