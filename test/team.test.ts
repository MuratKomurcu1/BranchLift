import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authenticateTeamToken, createTeamToken, listTeamRegistry, listTeamTokens, publishTeamRegistry, revokeTeamToken, teamRoleAllows } from "../src/team.js";
import type { RepoInfo } from "../src/types.js";
import { createWorkspaceTask } from "../src/workspace.js";

test("stores only hashed team tokens and enforces role ordering", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-team-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = home;
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  try {
    const created = await createTeamToken(repo, "reviewer", "viewer");
    assert.ok(created.token.length >= 32);
    assert.equal(await authenticateTeamToken(repo, created.token), "viewer");
    assert.equal(await authenticateTeamToken(repo, created.token + "invalid"), undefined);
    const listed = await listTeamTokens(repo);
    assert.equal(listed[0]?.label, "reviewer");
    assert.equal("digest" in (listed[0] ?? {}), false);
    assert.equal(teamRoleAllows("admin", "operator"), true);
    assert.equal(teamRoleAllows("viewer", "operator"), false);
    await revokeTeamToken(repo, created.definition.id);
    assert.equal(await authenticateTeamToken(repo, created.token), undefined);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("publishes a secret-free node record to a shared filesystem registry", async () => {
  const home = await mkdtemp(join(tmpdir(), "branchlift-registry-"));
  const previous = process.env.BRANCHLIFT_HOME;
  process.env.BRANCHLIFT_HOME = join(home, "state");
  const repo: RepoInfo = { root: join(home, "repo"), commonDir: join(home, "repo", ".git"), name: "demo", key: "demo-key" };
  try {
    await createWorkspaceTask(repo, { title: "Review auth", prompt: "private prompt", status: "review" });
    const published = await publishTeamRegistry(repo, join(home, "shared"));
    assert.equal(published.tasks[0]?.title, "Review auth");
    assert.equal("prompt" in (published.tasks[0] ?? {}), false);
    const listed = await listTeamRegistry(join(home, "shared"), repo.key);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.node.id, published.node.id);

    const recordPath = join(home, "outside.json");
    await writeFile(recordPath, JSON.stringify({ ...published, privateToken: "must-not-leak" }));
    await symlink(recordPath, join(home, "shared", "peer-symlink.json"));
    const withoutSymlink = await listTeamRegistry(join(home, "shared"), repo.key);
    assert.equal(withoutSymlink.length, 1);

    await writeFile(join(home, "shared", "peer-invalid.json"), JSON.stringify({
      ...published,
      tasks: [{ ...published.tasks[0], status: "untrusted-status" }],
    }));
    const withoutInvalid = await listTeamRegistry(join(home, "shared"), repo.key);
    assert.equal(withoutInvalid.length, 1);

    await writeFile(join(home, "shared", "peer-normalized.json"), JSON.stringify({ ...published, privateToken: "must-not-leak" }));
    const normalized = await listTeamRegistry(join(home, "shared"), repo.key);
    assert.equal(normalized.length, 2);
    assert.equal("privateToken" in (normalized[0] ?? {}), false);
  } finally {
    if (previous === undefined) delete process.env.BRANCHLIFT_HOME;
    else process.env.BRANCHLIFT_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
