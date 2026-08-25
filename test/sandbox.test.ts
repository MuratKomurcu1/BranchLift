import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxPosture } from "../src/sandbox.js";
import type { BranchLiftConfig } from "../src/types.js";

const config: BranchLiftConfig = {
  version: 1,
  compose: { files: ["compose.yaml"], statefulServices: [] },
  snapshot: { default: "dev", healthTimeoutSeconds: 120, seed: [] },
  worktree: { copyFiles: [] },
};

test("defaults to a resource-limited Docker boundary without the host socket", () => {
  const posture = sandboxPosture(config);
  assert.equal(posture.boundary, "container");
  assert.equal(posture.backend, "docker");
  assert.equal(posture.network, "backend");
  assert.equal(posture.readOnlyRoot, true);
  assert.equal(posture.hostDockerSocketMounted, false);
  assert.equal(posture.noNewPrivileges, true);
  assert.deepEqual(posture.resourceLimits, { memory: "4g", cpus: 2, pids: 512 });
});

test("labels host execution as having no security boundary", () => {
  const posture = sandboxPosture(config, { backend: "host", network: "outbound" });
  assert.equal(posture.boundary, "none");
  assert.ok(posture.warnings.some((warning) => /not a security boundary/.test(warning)));
  assert.ok(posture.warnings.some((warning) => /network egress/.test(warning)));
});
