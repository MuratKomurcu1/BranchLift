import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { benchmarkSnapshot } from "../dist/src/benchmark.js";
import { discoverRepo } from "../dist/src/git.js";
import { runCommand } from "../dist/src/process.js";

const project = {
  name: "Docmost",
  repo: "docmost/docmost",
  commit: "cd597f0161ab0221cae912cd9f8f71e2da6e607d",
  path: "docker-compose.yml",
};
const iterations = integerOption("--iterations", 3, 1, 10);
const timeoutSeconds = integerOption("--timeout", 300, 30, 900);
const datasetMiB = integerOption("--dataset-mib", 128, 0, 2048);
const datasetRows = datasetMiB * 1024;
const keep = process.argv.includes("--keep");
const root = await mkdtemp(join(tmpdir(), "branchlift-docmost-benchmark-"));
const stateHome = join(root, ".state");
const cli = resolve("dist/src/cli.js");
const env = { ...process.env, BRANCHLIFT_HOME: stateHome };
process.env.BRANCHLIFT_HOME = stateHome;
const composeFile = join(root, "docker-compose.yml");
const baselineOverride = join(root, "baseline.override.yaml");
const baselineSamplesMs = [];
const branchliftSamplesMs = [];
const branchNames = [];
let stateCloneBenchmark;

try {
  await fetchFixture(composeFile);
  await writeFile(baselineOverride, `services:\n  docmost:\n    ports: !override\n      - \"127.0.0.1::3000\"\n`);
  await writeFile(join(root, "branchlift.yaml"), branchliftConfig());
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "benchmark@branchlift.invalid"], root);
  await run("git", ["config", "user.name", "BranchLift Benchmark"], root);
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "Pinned Docmost benchmark fixture"], root);

  await run("docker", ["compose", "-f", composeFile, "pull"], root, true);
  const digests = await pinImages(composeFile, root);
  await run("git", ["add", "docker-compose.yml"], root);
  await run("git", ["commit", "-m", "Pin benchmark image digests"], root);

  // Golden-state construction is deliberately outside the timed samples: it is
  // the one-time preparation BranchLift amortizes across parallel worktrees.
  await run(process.execPath, [cli, "snapshot", "dev"], root, true);

  for (let index = 0; index < iterations; index += 1) {
    if (index % 2 === 0) {
      branchliftSamplesMs.push(await branchliftRun(index));
      baselineSamplesMs.push(await baselineRun(index));
    } else {
      baselineSamplesMs.push(await baselineRun(index));
      branchliftSamplesMs.push(await branchliftRun(index));
    }
  }

  stateCloneBenchmark = await benchmarkSnapshot(await discoverRepo(root), "dev", iterations);

  const baselineMedianMs = median(baselineSamplesMs);
  const branchliftMedianMs = median(branchliftSamplesMs);
  const platform = await platformInfo(root);
  console.log(JSON.stringify({
    project: project.name,
    source: `https://github.com/${project.repo}/tree/${project.commit}`,
    composePath: project.path,
    methodology: {
      traditional: "fresh Docker named volumes + application initialization + equivalent SQL seed + dataset verification + HTTP readiness",
      branchlift: "prebuilt immutable golden snapshot + CoW clone + dataset verification + Compose start + HTTP readiness",
      imageCache: "warm for both paths",
      goldenSnapshotBuildTimed: false,
      alternatingOrder: true,
    },
    iterations,
    datasetApproxMiB: datasetMiB,
    datasetRows,
    baselineSamplesMs: baselineSamplesMs.map(round),
    branchliftSamplesMs: branchliftSamplesMs.map(round),
    baselineMedianMs: round(baselineMedianMs),
    branchliftMedianMs: round(branchliftMedianMs),
    medianSpeedup: round(baselineMedianMs / branchliftMedianMs),
    stateCloneBenchmark,
    imageDigests: digests,
    platform,
  }, null, 2));

  async function baselineRun(index) {
    const composeProject = `branchlift-docmost-baseline-${process.pid}-${index}`;
    const started = performance.now();
    try {
      const composeArgs = ["compose", "-f", composeFile, "-f", baselineOverride, "-p", composeProject];
      await run("docker", [...composeArgs, "up", "-d", "--wait", "--wait-timeout", String(timeoutSeconds)], root);
      const address = (await run("docker", [...composeArgs, "port", "docmost", "3000"], root)).trim();
      const port = Number.parseInt(address.slice(address.lastIndexOf(":") + 1), 10);
      if (!Number.isInteger(port)) throw new Error(`Cannot parse Docmost port: ${address}`);
      await waitForHttp(`http://127.0.0.1:${port}`, timeoutSeconds);
      if (datasetRows > 0) await seedDataset(composeArgs, root);
      await verifyDataset(composeArgs, root);
      return performance.now() - started;
    } finally {
      await runBestEffort("docker", ["compose", "-f", composeFile, "-f", baselineOverride, "-p", composeProject, "down", "-v", "--remove-orphans"], root);
    }
  }

  async function branchliftRun(index) {
    const branch = `benchmark/branchlift-${process.pid}-${index}`;
    branchNames.push(branch);
    const started = performance.now();
    try {
      const output = await run(process.execPath, [cli, "spawn", branch, "--json"], root);
      const instance = JSON.parse(output);
      const port = instance.ports.find((candidate) => candidate.service === "docmost" && candidate.target === 3000)?.port;
      if (!Number.isInteger(port)) throw new Error("BranchLift did not publish Docmost port 3000");
      await waitForHttp(`http://127.0.0.1:${port}`, timeoutSeconds);
      const composeArgs = [
        "compose",
        ...(instance.composeFiles ?? [instance.composeFile]).flatMap((file) => ["-f", join(instance.worktreePath, file)]),
        "-f", instance.overrideFile,
        "-p", instance.composeProject,
      ];
      await verifyDataset(composeArgs, instance.worktreePath);
      return performance.now() - started;
    } finally {
      await runBestEffort(process.execPath, [cli, "destroy", branch, "--worktree"], root);
    }
  }
} finally {
  for (const branch of branchNames) await runBestEffort(process.execPath, [cli, "destroy", branch, "--worktree"], root);
  if (keep) process.stderr.write(`Benchmark fixture preserved at ${root}\n`);
  else await rm(root, { recursive: true, force: true });
}

async function fetchFixture(path) {
  const url = `https://raw.githubusercontent.com/${project.repo}/${project.commit}/${project.path}`;
  const response = await fetch(url, { headers: { "user-agent": "branchlift-benchmark" } });
  if (!response.ok) throw new Error(`${response.status} while fetching ${url}`);
  const text = (await response.text())
    .replace("REPLACE_WITH_LONG_SECRET", "branchlift-benchmark-secret-000000000000000000000000")
    .replaceAll("STRONG_DB_PASSWORD", "branchlift-benchmark-password");
  await writeFile(path, text);
}

async function pinImages(path, cwd) {
  let compose = await readFile(path, "utf8");
  const images = ["docmost/docmost:latest", "postgres:18", "redis:8"];
  const digests = {};
  for (const image of images) {
    const inspected = await run("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image], cwd);
    const digest = inspected.trim();
    if (!digest.includes("@sha256:")) throw new Error(`No immutable digest found for ${image}`);
    compose = compose.replace(image, digest);
    digests[image] = digest;
  }
  await writeFile(path, compose);
  return digests;
}

async function waitForHttp(url, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (response.status >= 200 && response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function seedDataset(composeArgs, cwd) {
  await run("docker", [...composeArgs, "exec", "-T", "db", ...postgresCommand(seedSql())], cwd);
}

async function verifyDataset(composeArgs, cwd) {
  if (datasetRows === 0) return;
  const count = (await run("docker", [...composeArgs, "exec", "-T", "db", ...postgresCommand("SELECT count(*) FROM branchlift_benchmark_payload;")], cwd)).trim();
  if (Number.parseInt(count, 10) !== datasetRows) throw new Error(`Dataset verification failed: expected ${datasetRows}, got ${count}`);
}

function postgresCommand(sql) {
  return ["psql", "-U", "docmost", "-d", "docmost", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql];
}

function seedSql() {
  return `CREATE TABLE branchlift_benchmark_payload (id bigint PRIMARY KEY, payload text NOT NULL); INSERT INTO branchlift_benchmark_payload SELECT value, repeat(md5(value::text), 32) FROM generate_series(1, ${datasetRows}) AS value; CHECKPOINT;`;
}

async function platformInfo(cwd) {
  const [docker, compose, filesystem] = await Promise.all([
    run("docker", ["version", "--format", "{{.Server.Version}}"], cwd),
    run("docker", ["compose", "version", "--short"], cwd),
    run("df", ["-T", cwd], cwd).catch(() => run("df", [cwd], cwd)),
  ]);
  return { node: process.version, os: `${process.platform}/${process.arch}`, docker: docker.trim(), compose: compose.trim(), filesystem: filesystem.trim().split("\n").filter(Boolean).at(-1) };
}

async function run(command, args, cwd, inherit = false) {
  const result = await runCommand(command, args, { cwd, env, stdio: inherit ? "inherit" : "capture" });
  return result.stdout;
}

async function runBestEffort(command, args, cwd) {
  await runCommand(command, args, { cwd, env, allowFailure: true });
}

function branchliftConfig() {
  const readiness = [
    "node",
    "-e",
    "const end=Date.now()+300000; (async()=>{while(Date.now()<end){try{const r=await fetch('http://127.0.0.1:3000');if(r.status<500)return}catch{} await new Promise(r=>setTimeout(r,500))}process.exit(1)})()",
  ];
  const seed = datasetRows === 0 ? [] : [{ service: "db", command: postgresCommand(seedSql()) }];
  return `version: 1
compose:
  files: [docker-compose.yml]
  statefulServices: [docmost, db, redis]
snapshot:
  default: dev
  healthTimeoutSeconds: ${timeoutSeconds}
  seed:
    - service: docmost
      command: ${JSON.stringify(readiness)}
${seed.map((step) => `    - service: ${step.service}\n      command: ${JSON.stringify(step.command)}`).join("\n")}
worktree:
  copyFiles: []
`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function integerOption(name, fallback, minimum, maximum) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}
