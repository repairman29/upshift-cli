import { spawn } from "child_process";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowedExitCodes: number[] = [0]
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (!allowedExitCodes.includes(exitCode)) {
        const error = new Error(`Command failed: ${command} ${args.join(" ")} (exit ${exitCode})`);
        Object.assign(error, { stdout, stderr, exitCode });
        reject(error);
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}
