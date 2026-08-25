import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHostPlatform, containerCli } from "../src/container.js";
import { runtimeNativeVolumeMap } from "../src/runtime.js";
import type { ComposeInspection } from "../src/types.js";

test("selects Docker by default and Podman explicitly", () => {
  assert.equal(containerCli({}), "docker");
  assert.equal(containerCli({ BRANCHLIFT_CONTAINER_CLI: "podman" }), "podman");
  assert.throws(() => containerCli({ BRANCHLIFT_CONTAINER_CLI: "containerd" }), /docker or podman/);
});

test("supports Windows through WSL2 without claiming native Windows support", () => {
  const nativeWindows = classifyHostPlatform("win32", "", "docker");
  assert.equal(nativeWindows.supported, false);
  assert.match(nativeWindows.guidance, /WSL2/);

  const wsl = classifyHostPlatform("linux", "5.15.146.1-microsoft-standard-WSL2", "podman");
  assert.equal(wsl.supported, true);
  assert.equal(wsl.environment, "wsl2");
  assert.equal(wsl.containerCli, "podman");
});

test("uses runtime-native MongoDB state on macOS and portable binds elsewhere", () => {
  const inspection: ComposeInspection = {
    file: "compose.yaml",
    files: ["compose.yaml"],
    services: ["mongo", "kafka"],
    inferredStatefulServices: ["mongo", "kafka"],
    volumes: [
      { source: "mongo-data", target: "/data/db", service: "mongo", readOnly: false, external: false },
      { source: "kafka-data", target: "/var/lib/kafka/data", service: "kafka", readOnly: false, external: false },
    ],
    ports: [],
    blockers: [],
    warnings: [],
    postgresServices: [],
    postgresDataDirectories: {},
    mysqlServices: [],
    mongodbServices: ["mongo"],
    kafkaServices: ["kafka"],
    serviceCommands: {},
    bindMounts: [],
    recommendations: [],
  };
  assert.deepEqual(
    [...runtimeNativeVolumeMap(inspection, "branchlift-project", "abc123", "darwin").keys()],
    ["mongo-data"],
  );
  assert.equal(runtimeNativeVolumeMap(inspection, "branchlift-project", "abc123", "linux").size, 0);
});
