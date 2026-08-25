import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join, resolve } from "node:path";
import {
  generateOverride,
  inspectCompose,
  mysqlDataVolumes,
  postgresDataVolumeNames,
  volumeDirectoryName,
} from "../src/compose.js";
import { runCommand } from "../src/process.js";
import { hasDockerComposeCli } from "./docker-availability.js";

const fixture = (name: string) => resolve("fixtures", name);

test("inspects stateful services, named volumes, and ports", async () => {
  const inspection = await inspectCompose(fixture("compose.valid.yaml"));

  assert.deepEqual(inspection.inferredStatefulServices, ["postgres", "redis"]);
  assert.deepEqual(inspection.postgresServices, ["postgres"]);
  assert.deepEqual(inspection.mysqlServices, []);
  assert.deepEqual(postgresDataVolumeNames(inspection), ["pgdata"]);
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
  const output = generateOverride(inspection, "/tmp/fork stack/volumes", {
    randomizePorts: true,
    postgresHostUser: { uid: 501, gid: 20 },
    bindHostUser: { uid: 501, gid: 20 },
  });

  assert.match(output, /\n    volumes:\n/);
  assert.doesNotMatch(output, /volumes: !override/);
  assert.match(output, /ports: !override/);
  assert.match(output, /source: "\/tmp\/fork stack\/volumes\/pgdata-[a-f0-9]{7}"/);
  assert.match(output, /target: "\/var\/lib\/postgresql\/data"/);
  assert.match(output, /PGDATA: "\/var\/lib\/postgresql\/data\/\.branchlift-pgdata"/);
  assert.equal(output.match(/user: "501:20"/g)?.length, 2);
  assert.match(output, /- "\/var\/run\/postgresql:uid=501,gid=20,mode=3775"/);
  assert.doesNotMatch(output, /published:/);
});

test("can bootstrap PostgreSQL in an explicitly named Docker volume", async () => {
  const inspection = await inspectCompose(fixture("compose.valid.yaml"));
  const output = generateOverride(inspection, "/tmp/branchlift/bootstrap", {
    randomizePorts: true,
    nativeVolumes: new Map([["pgdata", "branchlift-postgres-bootstrap"]]),
    postgresHostUser: false,
    bindHostUser: false,
  });

  assert.match(output, /type: volume\n\s+source: "pgdata"/);
  assert.match(output, /"pgdata":\n\s+name: "branchlift-postgres-bootstrap"/);
  assert.match(output, /source: "\/tmp\/branchlift\/bootstrap\/redisdata-[a-f0-9]{7}"/);
  assert.doesNotMatch(output, /user:/);
  assert.doesNotMatch(output, /tmpfs:/);
});

test("detects MySQL data and applies the macOS bind owner", async () => {
  const inspection = await inspectCompose(fixture("compose.mysql.yaml"));
  assert.deepEqual(inspection.mysqlServices, ["mysql"]);
  assert.deepEqual(mysqlDataVolumes(inspection).map(({ source, target }) => ({ source, target })), [
    { source: "mysqldata", target: "/var/lib/mysql" },
  ]);

  const output = generateOverride(inspection, "/tmp/branchlift/mysql", {
    randomizePorts: true,
    mysqlHostUser: { uid: 501, gid: 20 },
  });
  assert.match(output, /source: "\/tmp\/branchlift\/mysql\/mysqldata-[a-f0-9]{7}"/);
  assert.match(output, /user: "501:20"/);
  assert.match(output, /command: \["--lower-case-table-names=1"\]/);
  assert.doesNotMatch(output, /PGDATA:/);
});

test("reports isolation blockers instead of silently sharing state", async () => {
  const inspection = await inspectCompose(fixture("compose.blocked.yaml"));

  assert.ok(inspection.blockers.some((item) => item.includes("container_name")));
  assert.ok(inspection.blockers.some((item) => item.includes("host networking")));
  assert.ok(inspection.blockers.some((item) => item.includes("no managed named volume")));
  assert.ok(inspection.blockers.some((item) => item.includes("external")));
  assert.ok(inspection.blockers.some((item) => item.includes("Shared writable bind mount")));
  assert.ok(inspection.recommendations.some((item) => item.includes("container_name")));
});

test("volume directory names are stable and path-safe", () => {
  assert.equal(volumeDirectoryName("postgres/data"), volumeDirectoryName("postgres/data"));
  assert.doesNotMatch(volumeDirectoryName("../../danger"), /\//);
});

test("generated state mounts preserve unrelated Compose bind mounts", { skip: !hasDockerComposeCli }, async () => {
  const root = await mkdtemp(join(tmpdir(), "branchlift-compose-mounts-"));
  try {
    const base = join(root, "compose.yaml");
    const override = join(root, "branchlift.override.yaml");
    await writeFile(base, `services:\n  postgres:\n    image: postgres:16\n    ports: ["5432:5432"]\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n      - ./init:/docker-entrypoint-initdb.d:ro\nvolumes:\n  pgdata: {}\n`);
    const inspection = await inspectCompose(base);
    assert.deepEqual(inspection.bindMounts.map(({ readOnly, sharedAcrossWorktrees }) => ({ readOnly, sharedAcrossWorktrees })), [
      { readOnly: true, sharedAcrossWorktrees: false },
    ]);
    await writeFile(override, generateOverride(inspection, join(root, "state"), {
      randomizePorts: true,
      postgresHostUser: false,
    }));

    const merged = await runCommand("docker", ["compose", "-f", base, "-f", override, "config", "--format", "json"], { cwd: root });
    const document = JSON.parse(merged.stdout) as { services: { postgres: { volumes: Array<{ type: string; target: string; read_only?: boolean }> } } };
    assert.deepEqual(document.services.postgres.volumes.map(({ type, target }) => ({ type, target })), [
      { type: "bind", target: "/var/lib/postgresql/data" },
      { type: "bind", target: "/docker-entrypoint-initdb.d" },
    ]);
    assert.equal(document.services.postgres.volumes[1]?.read_only, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
