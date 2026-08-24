import assert from "node:assert/strict";
import { test } from "node:test";
import { parseComposeVersion } from "../src/docker.js";

test("parses stable and vendor-suffixed Docker Compose versions", () => {
  assert.deepEqual(parseComposeVersion("Docker Compose version v2.39.4-desktop.1"), [2, 39, 4]);
  assert.deepEqual(parseComposeVersion("Docker Compose version 2.24.4"), [2, 24, 4]);
  assert.equal(parseComposeVersion("unknown"), undefined);
});
