import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { generateOverride, inspectCompose, volumeDirectoryName } from "../src/compose.js";

const fixture = (name: string) => resolve("fixtures", name);

test("inspects stateful services, named volumes, and ports", async () => {
  const inspection = await inspectCompose(fixture("compose.valid.yaml"));

  assert.deepEqual(inspection.inferredStatefulServices, ["postgres", "redis"]);
  assert.deepEqual(inspection.postgresServices, ["postgres"]);
  assert.deepEqual(
    [...new Set(inspection.volumes.map((volume) => volume.source))].sort(),
    ["pgdata", "redisdata"],
  );
  assert.deepEqual(
    inspection.ports.map((port) => `${port.service}:${port.target}/${port.protocol}`).sort(),
    ["api:3000/tcp", "postgres:5432/tcp", "redis:6379/tcp"],
  );
  assert.deepEqual(inspection.blockers, []);
});

test("generates a Compose override with bind-mounted state and random ports", async () => {
  const inspection = await inspectCompose(fixture("compose.valid.yaml"));
  const output = generateOverride(inspection, "/tmp/fork stack/volumes", { randomizePorts: true });

  assert.match(output, /volumes: !override/);
  assert.match(output, /ports: !override/);
  assert.match(output, /source: "\/tmp\/fork stack\/volumes\/pgdata-[a-f0-9]{7}"/);
  assert.match(output, /target: "\/var\/lib\/postgresql\/data"/);
  assert.match(output, /PGDATA: "\/var\/lib\/postgresql\/data\/\.branchlift-pgdata"/);
  assert.doesNotMatch(output, /published:/);
});

test("reports isolation blockers instead of silently sharing state", async () => {
  const inspection = await inspectCompose(fixture("compose.blocked.yaml"));

  assert.ok(inspection.blockers.some((item) => item.includes("container_name")));
  assert.ok(inspection.blockers.some((item) => item.includes("host networking")));
  assert.ok(inspection.blockers.some((item) => item.includes("no managed named volume")));
  assert.ok(inspection.blockers.some((item) => item.includes("external")));
});

test("volume directory names are stable and path-safe", () => {
  assert.equal(volumeDirectoryName("postgres/data"), volumeDirectoryName("postgres/data"));
  assert.doesNotMatch(volumeDirectoryName("../../danger"), /\//);
});
