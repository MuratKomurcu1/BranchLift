import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkSnapshot } from "../dist/src/benchmark.js";
import { snapshotRoot } from "../dist/src/paths.js";
import { volumeDirectoryName } from "../dist/src/compose.js";
import { writeSnapshotMetadata } from "../dist/src/state.js";
import { runCommand } from "../dist/src/process.js";

const sizeMiB = integerOption("--size-mib", 64, 1, 4096);
const iterations = integerOption("--iterations", 5, 1, 100);
const root = await mkdtemp(join(tmpdir(), "branchlift-benchmark-"));
const stateRoot = join(root, "state");
process.env.BRANCHLIFT_HOME = stateRoot;
const repo = { root, commonDir: join(root, ".git"), name: "synthetic", key: "synthetic-benchmark" };
const volumeName = "benchmark-data";
const volume = join(snapshotRoot(repo, "synthetic"), "volumes", volumeDirectoryName(volumeName));
await mkdir(volume, { recursive: true });
const chunk = Buffer.alloc(1024 * 1024);
for (let index = 0; index < chunk.length; index += 4096) chunk[index] = index % 251;
for (let index = 0; index < sizeMiB; index += 1) await writeFile(join(volume, `${index}.bin`), chunk);
const now = new Date().toISOString();
await writeSnapshotMetadata(repo, "synthetic", {
  version: 1,
  name: "synthetic",
  repoKey: repo.key,
  sourceRoot: repo.root,
  composeFile: "compose.yaml",
  composeProject: "synthetic",
  createdAt: now,
  completedAt: now,
  status: "ready",
  volumeNames: [volumeName],
  sizeBytes: sizeMiB * 1024 * 1024,
});

const result = await benchmarkSnapshot(repo, "synthetic", iterations);
let filesystem = await runCommand("df", ["-T", root], { allowFailure: true });
if (filesystem.exitCode !== 0) filesystem = await runCommand("df", [root], { allowFailure: true });
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixtureMiB: sizeMiB,
  methodology: "alternating native clone/reflink and forced full-copy samples on the same warm filesystem",
  platform: {
    node: process.version,
    os: process.platform,
    arch: process.arch,
    filesystem: filesystem.stdout.trim().split("\n").filter(Boolean).at(-1),
  },
  ...result,
}, null, 2));

function integerOption(name, fallback, minimum, maximum) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
