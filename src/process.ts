import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";
import { BranchLiftError, CommandError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "capture";
  allowFailure?: boolean;
  input?: string | Buffer;
  maxOutputBytes?: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const capture = options.stdio !== "inherit";

  return await new Promise<CommandResult>((resolve, reject) => {
    if (options.maxOutputBytes !== undefined && (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)) {
      reject(new BranchLiftError("maxOutputBytes must be a positive integer."));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.input === undefined
        ? capture ? ["ignore", "pipe", "pipe"] : "inherit"
        : ["pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
      shell: false,
    });

    if (options.input !== undefined) child.stdin?.end(options.input);

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const append = (stream: "stdout" | "stderr", chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          reject(new BranchLiftError(`Command output exceeded the ${options.maxOutputBytes} byte safety limit: ${formatCommand(command, args)}`));
        }
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
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
