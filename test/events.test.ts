import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listEvents, recordEvent } from "../src/events.js";
import type { RepoInfo } from "../src/types.js";

test("records bounded audit events and redacts sensitive detail keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-events-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  try {
    await recordEvent(repo, "Instance Spawn", "created", {
      branch: "feature/api",
      details: { token: "must-not-appear", status: "running" },
    });
    const events = await listEvents(repo, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "instance.spawn");
    assert.equal(events[0]?.details?.token, "[redacted]");
    assert.equal(events[0]?.details?.status, "running");
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
