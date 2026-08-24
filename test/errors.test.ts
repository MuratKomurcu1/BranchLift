import assert from "node:assert/strict";
import { test } from "node:test";
import { BranchLiftError, errorDetail } from "../src/errors.js";

test("preserves actionable BranchLift error hints in persisted diagnostics", () => {
  assert.equal(
    errorDetail(new BranchLiftError("Compose failed.", "postgres: permission denied")),
    "Compose failed.\npostgres: permission denied",
  );
  assert.equal(errorDetail(new Error("plain failure")), "plain failure");
});
