/**
 * Go upgrade: go get with backup, test, rollback.
 */

import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import { loadConfig } from "./config.js";

export type GoUpgradeOptions = {
  cwd: string;
  packageName: string;
  toVersion?: string;
  dryRun: boolean;
  yes?: boolean;
  skipTests?: boolean;
};

export function createBackupGo(cwd: string): string {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, stamp);
  mkdirSync(backupDir, { recursive: true });

  const files = ["go.mod", "go.sum"];
  for (const file of files) {
    const src = path.join(cwd, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(backupDir, file));
    }
  }
  return backupDir;
}

function findLatestBackup(cwd: string): string | null {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  if (!existsSync(backupRoot)) return null;
  const entries = readdirSync(backupRoot).sort().reverse();
  const latest = entries[0];
  return latest ? path.join(backupRoot, latest) : null;
}

export function tryRollbackGo(cwd: string, backupDir?: string): void {
  const resolved = backupDir ?? findLatestBackup(cwd);
  if (!resolved) return;

  process.stdout.write(chalk.red("Attempting rollback...\n"));
  const files = ["go.mod", "go.sum"];
  for (const file of files) {
    const src = path.join(resolved, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(cwd, file));
    }
  }

  runCommand("go", ["mod", "tidy"], cwd).catch(() => {
    process.stdout.write(chalk.red("Rollback go mod tidy failed. Run go mod tidy manually.\n"));
  });
}

export function getTestCommandGo(cwd: string): string[] | null {
  const config = loadConfig(cwd);
  const tc = config.testCommand;
  if (tc) {
    if (Array.isArray(tc)) return tc;
    return (tc as string).trim().split(/\s+/);
  }
  return ["go", "test", "./..."];
}

export async function runGoUpgrade(options: GoUpgradeOptions): Promise<void> {
  const spinner = ora(`Upgrading ${options.packageName} (Go)...`).start();
  const backupDir = createBackupGo(options.cwd);
  const target = options.toVersion ? `@${options.toVersion}` : "@latest";

  if (options.dryRun) {
    spinner.succeed("Dry run complete");
    process.stdout.write(
      [
        "Package manager: go",
        `Command: go get ${options.packageName}${target}`,
        `Backup dir: ${backupDir}`,
        "Tests: go test ./... or config testCommand",
      ].join("\n") + "\n"
    );
    return;
  }

  try {
    await runCommand("go", ["get", `${options.packageName}${target}`], options.cwd);
    await runCommand("go", ["mod", "tidy"], options.cwd);
  } catch (err) {
    spinner.fail("Upgrade failed");
    tryRollbackGo(options.cwd);
    throw err;
  }

  const testCmd = getTestCommandGo(options.cwd);
  if (!options.skipTests && testCmd?.length) {
    process.stdout.write(chalk.gray("Running tests...\n"));
    try {
      await runCommand(testCmd[0], testCmd.slice(1), options.cwd);
      process.stdout.write(chalk.green("Tests passed.\n"));
    } catch {
      process.stdout.write(chalk.red("Tests failed. Rolling back.\n"));
      tryRollbackGo(options.cwd);
      throw new Error("Tests failed after upgrade");
    }
  } else if (!options.skipTests) {
    process.stdout.write(chalk.gray("No test command configured. Skipping tests.\n"));
  }

  const { emitAuditEvent } = await import("./audit-log.js");
  await emitAuditEvent("upgrade", "package", options.packageName, {
    ecosystem: "go",
    outcome: "success",
  });

  spinner.succeed("Upgrade complete");
}
