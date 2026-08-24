import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";
import { CommandError } from "./errors.js";

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "capture";
  allowFailure?: boolean;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const capture = options.stdio !== "inherit";

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }

    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      const exitCode = code ?? 1;
      const result = { stdout, stderr, exitCode };
      if (exitCode !== 0 && options.allowFailure !== true) {
        reject(new CommandError(formatCommand(command, args), exitCode, stderr));
      } else {
        resolve(result);
      }
    });
  });
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}
