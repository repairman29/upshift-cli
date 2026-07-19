/**
 * Ruby upgrade: bundle update with backup, test, rollback.
 */

import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import { loadConfig } from "./config.js";

export type RubyUpgradeOptions = {
  cwd: string;
  packageName: string;
  toVersion?: string;
  dryRun: boolean;
  yes?: boolean;
  skipTests?: boolean;
};

export function createBackupRuby(cwd: string): string {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, stamp);
  mkdirSync(backupDir, { recursive: true });

  const files = ["Gemfile", "Gemfile.lock"];
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

export function tryRollbackRuby(cwd: string, backupDir?: string): void {
  const resolved = backupDir ?? findLatestBackup(cwd);
  if (!resolved) return;

  process.stdout.write(chalk.red("Attempting rollback...\n"));
  const files = ["Gemfile", "Gemfile.lock"];
  for (const file of files) {
    const src = path.join(resolved, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(cwd, file));
    }
  }

  runCommand("bundle", ["install"], cwd).catch(() => {
    process.stdout.write(chalk.red("Rollback bundle install failed. Run bundle install manually.\n"));
  });
}

export async function getTestCommandRuby(cwd: string): Promise<string[] | null> {
  const config = loadConfig(cwd);
  const tc = config.testCommand;
  if (tc) {
    if (Array.isArray(tc)) return tc;
    return (tc as string).trim().split(/\s+/);
  }
  if (existsSync(path.join(cwd, "spec"))) return ["bundle", "exec", "rspec"];
  if (existsSync(path.join(cwd, "test"))) return ["bundle", "exec", "rake", "test"];
  try {
    await runCommand("bundle", ["exec", "rspec", "--version"], cwd, [0, 1]);
    return ["bundle", "exec", "rspec"];
  } catch {
    return ["bundle", "exec", "rake", "test"];
  }
}

export async function runRubyUpgrade(options: RubyUpgradeOptions): Promise<void> {
  const spinner = ora(`Upgrading ${options.packageName} (Ruby)...`).start();
  const backupDir = createBackupRuby(options.cwd);

  if (options.dryRun) {
    spinner.succeed("Dry run complete");
    process.stdout.write(
      [
        "Package manager: bundler",
        `Command: bundle update ${options.packageName}`,
        `Backup dir: ${backupDir}`,
        "Tests: bundle exec rspec or config testCommand",
      ].join("\n") + "\n"
    );
    return;
  }

  try {
    await runCommand("bundle", ["update", options.packageName], options.cwd);
  } catch (err) {
    spinner.fail("Upgrade failed");
    tryRollbackRuby(options.cwd);
    throw err;
  }

  const testCmd = await getTestCommandRuby(options.cwd);
  if (!options.skipTests && testCmd?.length) {
    process.stdout.write(chalk.gray("Running tests...\n"));
    try {
      await runCommand(testCmd[0], testCmd.slice(1), options.cwd);
      process.stdout.write(chalk.green("Tests passed.\n"));
    } catch {
      process.stdout.write(chalk.red("Tests failed. Rolling back.\n"));
      tryRollbackRuby(options.cwd);
      throw new Error("Tests failed after upgrade");
    }
  } else if (!options.skipTests) {
    process.stdout.write(chalk.gray("No test command configured. Skipping tests.\n"));
  }

  const { emitAuditEvent } = await import("./audit-log.js");
  await emitAuditEvent("upgrade", "package", options.packageName, {
    ecosystem: "ruby",
    outcome: "success",
  });

  spinner.succeed("Upgrade complete");
}
