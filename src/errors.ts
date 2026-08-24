export class BranchLiftError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "BranchLiftError";
    if (hint !== undefined) this.hint = hint;
  }
}

export class CommandError extends BranchLiftError {
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;

  constructor(command: string, exitCode: number, stderr: string) {
    const detail = stderr.trim();
    super(`Command failed (${exitCode}): ${command}${detail ? `\n${detail}` : ""}`);
    this.name = "CommandError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function errorDetail(error: unknown): string {
  if (error instanceof BranchLiftError) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
