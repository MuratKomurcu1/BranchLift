import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parse, stringify } from "yaml";
import { runCommand } from "../dist/src/process.js";

const projects = JSON.parse(await readFile(new URL("../evidence/projects.json", import.meta.url), "utf8"));
const slug = option("--project");
const output = option("--output", false);
const project = projects.find((candidate) => candidate.slug === slug);
if (project === undefined) throw new Error(`Unknown --project ${slug}; expected ${projects.map((item) => item.slug).join(", ")}`);

const root = await mkdtemp(join(tmpdir(), `branchlift-evidence-${project.slug}-`));
const stateHome = join(root, ".branchlift-state");
const cli = resolve("dist/src/cli.js");
const env = {
  ...process.env,
  BRANCHLIFT_HOME: stateHome,
  TELEMETRY_ENABLED: "false",
};
const composeFile = join(root, "compose.yaml");
const branch = `evidence/${project.slug}`;
const timings = {};
let instance;
let passed = false;
let destroyed = false;

try {
  let composeText = await fetchText(rawUrl(project.repo, project.commit, project.path));
  composeText = composeText
    .replaceAll("REPLACE_WITH_LONG_SECRET", "branchlift-evidence-secret-000000000000000000000000")
    .replaceAll("STRONG_DB_PASSWORD", "branchlift-evidence-password");
  await writeFile(composeFile, composeText);
  for (const supportPath of project.support ?? []) {
    const destination = join(root, basename(supportPath));
    await writeFile(destination, await fetchText(rawUrl(project.repo, project.commit, supportPath)));
    await chmod(destination, 0o755);
  }
  if (project.slug === "n8n") {
    await writeFile(join(root, ".env"), [
      "N8N_VERSION=stable",
      "POSTGRES_USER=branchlift_root",
      "POSTGRES_PASSWORD=branchlift-password",
      "POSTGRES_DB=n8n",
      "POSTGRES_NON_ROOT_USER=branchlift_n8n",
      "POSTGRES_NON_ROOT_PASSWORD=branchlift-password",
      "RUNNERS_AUTH_TOKEN=branchlift-evidence-runner-token-00000000",
      "",
    ].join("\n"));
    await writeFile(join(root, ".gitignore"), ".env\n");
  }

  await run("docker", ["compose", "-f", composeFile, "pull"], root, true);
  const imageDigests = await pinResolvedImages(composeFile, root);
  await writeFile(join(root, "branchlift.yaml"), branchliftConfig(project));
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.email", "evidence@branchlift.invalid"], root);
  await run("git", ["config", "user.name", "BranchLift Evidence"], root);
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", `Pin ${project.name} evidence fixture`], root);

  timings.snapshotMs = await timed(async () => {
    await run(process.execPath, [cli, "snapshot", "evidence"], root, true);
  });
  timings.spawnMs = await timed(async () => {
    instance = JSON.parse(await run(process.execPath, [cli, "spawn", branch, "--snapshot", "evidence", "--json"], root));
  });
  const appPort = instance.ports.find((port) => port.service === project.appService && port.target === project.appPort)?.port;
  if (!Number.isInteger(appPort)) throw new Error(`${project.name}: application port was not published`);
  let readinessUrl = `http://127.0.0.1:${appPort}${project.readyPath}`;
  let httpStatus = await waitForHttp(readinessUrl, 180);
  assertEvidenceValue(await queryEvidence(instance, project), "golden");
  await mutateEvidence(instance, project, "mutated");
  assertEvidenceValue(await queryEvidence(instance, project), "mutated");

  timings.resetMs = await timed(async () => {
    await run(process.execPath, [cli, "reset", branch], root, true);
  });
  instance = (JSON.parse(await run(process.execPath, [cli, "list", "--json"], root))).find((item) => item.branch === branch);
  if (instance === undefined) throw new Error(`${project.name}: reset instance disappeared`);
  const resetAppPort = instance.ports.find((port) => port.service === project.appService && port.target === project.appPort)?.port;
  if (!Number.isInteger(resetAppPort)) throw new Error(`${project.name}: reset application port was not published`);
  readinessUrl = `http://127.0.0.1:${resetAppPort}${project.readyPath}`;
  httpStatus = await waitForHttp(readinessUrl, 180);
  assertEvidenceValue(await queryEvidence(instance, project), "golden");
  const preview = JSON.parse(await run(process.execPath, [cli, "preview", branch, "--json"], root));
  if (!preview[0]?.services?.some((service) => service.state === "running")) {
    throw new Error(`${project.name}: preview did not report running services`);
  }
  await run(process.execPath, [cli, "destroy", branch, "--worktree"], root, true);
  destroyed = true;

  const result = {
    generatedAt: new Date().toISOString(),
    project: project.name,
    source: `https://github.com/${project.repo}/tree/${project.commit}`,
    composePath: project.path,
    imageDigests,
    lifecycle: ["snapshot", "spawn", "HTTP readiness", "state verification", "mutation", "reset", "golden-state verification", "destroy"],
    httpStatus,
    services: preview[0].services,
    endpoints: preview[0].endpoints,
    readinessUrl,
    copyStrategy: instance.copyStrategy,
    timings,
    result: "passed",
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output !== undefined) await writeFile(resolve(output), serialized);
  process.stdout.write(serialized);
  passed = true;
} finally {
  if (!passed && process.env.BRANCHLIFT_EVIDENCE_KEEP_FAILED === "1") {
    process.stderr.write(`Failed evidence workspace kept at ${root}\n`);
  } else {
    if (!destroyed) await runBestEffort(process.execPath, [cli, "destroy", branch, "--worktree"], root);
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      if (passed) throw error;
      process.stderr.write(`Evidence cleanup warning: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function pinResolvedImages(path, cwd) {
  const resolved = JSON.parse(await run("docker", ["compose", "-f", path, "config", "--format", "json"], cwd));
  const document = parse(await readFile(path, "utf8"));
  const digests = {};
  for (const [service, definition] of Object.entries(resolved.services ?? {})) {
    const image = definition.image;
    if (typeof image !== "string") continue;
    const digest = (await run("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image], cwd)).trim();
    if (!digest.includes("@sha256:")) throw new Error(`${service}: no immutable RepoDigest for ${image}`);
    document.services[service].image = digest;
    digests[service] = digest;
  }
  await writeFile(path, stringify(document, { indent: 2 }));
  return digests;
}

function branchliftConfig(project) {
  const readiness = [
    "node",
    "-e",
    `const end=Date.now()+180000;(async()=>{while(Date.now()<end){try{const r=await fetch('http://${project.appService}:${project.appPort}${project.readyPath}');if(r.status<500)return}catch{}await new Promise(r=>setTimeout(r,500))}process.exit(1)})()`,
  ];
  const sql = "CREATE TABLE branchlift_evidence (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO branchlift_evidence VALUES (1, 'golden'); CHECKPOINT;";
  return stringify({
    version: 1,
    compose: { files: ["compose.yaml"], statefulServices: project.statefulServices },
    snapshot: {
      default: "evidence",
      healthTimeoutSeconds: 180,
      seed: [
        { service: project.appService, command: readiness },
        { service: project.dbService, command: postgresCommand(project, sql) },
      ],
    },
    worktree: { copyFiles: project.slug === "n8n" ? [".env"] : [] },
  }, { indent: 2 });
}

async function queryEvidence(instance, project) {
  return (await composeExec(instance, project.dbService, postgresCommand(project, "SELECT value FROM branchlift_evidence WHERE id = 1;"))).trim();
}

async function mutateEvidence(instance, project, value) {
  await composeExec(instance, project.dbService, postgresCommand(project, `UPDATE branchlift_evidence SET value = '${value}' WHERE id = 1;`));
}

function postgresCommand(project, sql) {
  return ["psql", "-U", project.dbUser, "-d", project.database, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql];
}

async function composeExec(instance, service, command) {
  const files = (instance.composeFiles ?? [instance.composeFile]).flatMap((file) => ["-f", join(instance.worktreePath, file)]);
  return await run("docker", ["compose", ...files, "-f", instance.overrideFile, "-p", instance.composeProject, "exec", "-T", service, ...command], instance.worktreePath);
}

async function waitForHttp(url, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      if (response.status >= 200 && response.status < 500) return response.status;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

function assertEvidenceValue(actual, expected) {
  if (actual !== expected) throw new Error(`State verification failed: expected ${expected}, got ${actual}`);
}

async function timed(task) {
  const started = performance.now();
  await task();
  return Math.round((performance.now() - started) * 100) / 100;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "branchlift-evidence" } });
  if (!response.ok) throw new Error(`${response.status} while fetching ${url}`);
  return await response.text();
}

function rawUrl(repo, commit, path) {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
}

async function run(command, args, cwd, inherit = false) {
  const result = await runCommand(command, args, { cwd, env, stdio: inherit ? "inherit" : "capture" });
  return result.stdout;
}

async function runBestEffort(command, args, cwd) {
  await runCommand(command, args, { cwd, env, allowFailure: true });
}

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (value === undefined || value.startsWith("--"))) throw new Error(`${name} requires a value`);
  return value;
}
