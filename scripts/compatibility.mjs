import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { generateOverride, inspectCompose } from "../dist/src/compose.js";

const manifest = JSON.parse(await readFile(new URL("../compatibility/projects.json", import.meta.url), "utf8"));
const root = await mkdtemp(join(tmpdir(), "branchlift-compat-"));
const results = [];

for (const project of manifest) {
  const url = `https://raw.githubusercontent.com/${project.repo}/${project.commit}/${project.path}`;
  const response = await fetch(url, { headers: { "user-agent": "branchlift-compatibility" } });
  if (!response.ok) throw new Error(`${project.name}: ${response.status} while fetching ${url}`);
  const composeFile = join(root, `${slug(project.name)}.yaml`);
  await writeFile(composeFile, await response.text());
  const inspection = await inspectCompose(composeFile);
  const override = generateOverride(inspection, join(root, "volumes"), { randomizePorts: true });
  // The generic YAML parser does not implement Compose's collection tag; the
  // generated document is syntax-checked after removing only that known tag.
  parse(override.replaceAll("!override", ""));

  requireMembers(project.name, "services", inspection.services, project.services ?? []);
  requireMembers(project.name, "volumes", inspection.volumes.map(({ source }) => source), project.volumes ?? []);
  if (project.expected === "compatible" && inspection.blockers.length > 0) {
    throw new Error(`${project.name}: expected compatibility, got ${inspection.blockers.join(" | ")}`);
  }
  if (project.expected === "diagnosed") {
    if (inspection.blockers.length === 0) throw new Error(`${project.name}: expected an actionable diagnosis`);
    for (const fragment of project.blockers ?? []) {
      if (!inspection.blockers.some((blocker) => blocker.includes(fragment))) {
        throw new Error(`${project.name}: missing expected blocker fragment: ${fragment}`);
      }
    }
    if (inspection.recommendations.length === 0) throw new Error(`${project.name}: diagnosis has no recommendation`);
  }
  results.push({
    name: project.name,
    commit: project.commit.slice(0, 12),
    expected: project.expected,
    services: inspection.services.length,
    cloneableVolumes: new Set(inspection.volumes.map(({ source }) => source)).size,
    blockers: inspection.blockers.length,
  });
}

await rm(root, { recursive: true, force: true });

if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
else {
  console.log("PROJECT\tRESULT\tSERVICES\tVOLUMES\tBLOCKERS\tCOMMIT");
  for (const result of results) {
    console.log(`${result.name}\t${result.expected}\t${result.services}\t${result.cloneableVolumes}\t${result.blockers}\t${result.commit}`);
  }
  console.log(`Compatibility contract passed for ${results.length} pinned projects.`);
}

function requireMembers(project, kind, actual, expected) {
  for (const value of expected) {
    if (!actual.includes(value)) throw new Error(`${project}: missing expected ${kind.slice(0, -1)} ${value}`);
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
