import { spawnSync } from "node:child_process";

export const hasDockerComposeCli = spawnSync("docker", ["compose", "version"], {
  stdio: "ignore",
}).status === 0;
