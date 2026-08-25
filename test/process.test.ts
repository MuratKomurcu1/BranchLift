import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "../src/process.js";

test("bounded command capture terminates output floods", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(8192))"], { maxOutputBytes: 1024 }),
    /output exceeded the 1024 byte safety limit/,
  );
});
