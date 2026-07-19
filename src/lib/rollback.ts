import chalk from "chalk";
import ora from "ora";
import { existsSync, readdirSync, copyFileSync, rmSync } from "fs";
import path from "path";
import { select, confirm } from "@inquirer/prompts";
import { runCommand } from "./exec.js";

export type RollbackOptions = {
  cwd: string;
  interactive?: boolean;
  all?: boolean;
  yes?: boolean;
};

type BackupInfo = {
  timestamp: string;
  date: Date;
  path: string;
  files: string[];
};

export async function runRollback(options: RollbackOptions): Promise<void> {
  const backupRoot = path.join(options.cwd, ".upshift", "backups");

  if (!existsSync(backupRoot)) {
    console.log(chalk.yellow("No backups found."));
    console.log(chalk.gray("Backups are created automatically when you run `upshift upgrade`."));
    return;
  }

  const backups = getBackups(backupRoot);

  if (backups.length === 0) {
    console.log(chalk.yellow("No backups found."));
    return;
  }

  // List mode
  if (!options.interactive && !options.all) {
    // Default: rollback to most recent
    const latest = backups[0];

    if (options.yes) {
      console.log(chalk.gray(`Restoring latest backup (${formatDate(latest.date)})...`));
      await restoreBackup(options.cwd, latest);
      return;
    }

    if (!process.stdin.isTTY) {
      console.log(chalk.yellow("Non-interactive terminal: cannot prompt for confirmation."));
      console.log(chalk.gray("Run `upshift rollback --yes` to restore the latest backup without a prompt."));
      process.exit(1);
    }

    console.log(chalk.bold("\nAvailable backups:\n"));
    for (let i = 0; i < Math.min(backups.length, 5); i++) {
      const b = backups[i];
      const marker = i === 0 ? chalk.green(" (latest)") : "";
      console.log(`  ${i + 1}. ${formatDate(b.date)}${marker}`);
      console.log(chalk.gray(`     Files: ${b.files.join(", ")}`));
    }

    if (backups.length > 5) {
      console.log(chalk.gray(`\n  ... and ${backups.length - 5} more`));
    }

    console.log("");
    const proceed = await confirm({
      message: `Rollback to ${formatDate(latest.date)}?`,
      default: true,
    });

    if (!proceed) {
      console.log(chalk.gray("\nCancelled.\n"));
      return;
    }

    await restoreBackup(options.cwd, latest);
    return;
  }

  // Interactive mode - let user choose
  if (options.interactive) {
    const choices = backups.slice(0, 10).map((b, i) => ({
      name: `${formatDate(b.date)} - ${b.files.join(", ")}`,
      value: i,
    }));

    const selected = await select({
      message: "Select a backup to restore:",
      choices,
    });

    const backup = backups[selected];
    await restoreBackup(options.cwd, backup);
    return;
  }

  // All mode - clear all backups
  if (options.all) {
    console.log(chalk.bold(`\nThis will delete ${backups.length} backups.\n`));

    const proceed = await confirm({
      message: "Are you sure?",
      default: false,
    });

    if (!proceed) {
      console.log(chalk.gray("\nCancelled.\n"));
      return;
    }

    const spinner = ora("Cleaning up backups...").start();

    try {
      rmSync(backupRoot, { recursive: true, force: true });
      spinner.succeed(`Deleted ${backups.length} backups`);
    } catch (error) {
      spinner.fail("Failed to delete backups");
      throw error;
    }
    return;
  }
}

function getBackups(backupRoot: string): BackupInfo[] {
  const entries = readdirSync(backupRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  return entries.map((timestamp) => {
    const backupPath = path.join(backupRoot, timestamp);
    const files = readdirSync(backupPath);

    // Parse timestamp: 2024-01-15T10-30-00-000Z
    const date = new Date(
      timestamp.replace(/-/g, (m, i) => (i < 10 ? "-" : i < 13 ? "T" : i < 19 ? ":" : ".")).slice(0, -1) + "Z"
    );

    return {
      timestamp,
      date: isNaN(date.getTime()) ? new Date() : date,
      path: backupPath,
      files,
    };
  });
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

async function restoreBackup(cwd: string, backup: BackupInfo): Promise<void> {
  const spinner = ora("Restoring backup...").start();

  try {
    // Copy files back
    for (const file of backup.files) {
      const src = path.join(backup.path, file);
      const dest = path.join(cwd, file);

      if (existsSync(src)) {
        copyFileSync(src, dest);
      }
    }

    spinner.text = "Reinstalling dependencies...";

    // Reinstall
    await runCommand("npm", ["install"], cwd);

    spinner.succeed("Rollback complete");

    console.log(chalk.green(`\n✔ Restored to ${formatDate(backup.date)}`));
    console.log(chalk.gray("  Files restored: " + backup.files.join(", ")));
    console.log("");
  } catch (error) {
    spinner.fail("Rollback failed");
    throw error;
  }
}

export async function listBackups(cwd: string): Promise<void> {
  const backupRoot = path.join(cwd, ".upshift", "backups");

  if (!existsSync(backupRoot)) {
    console.log(chalk.yellow("No backups found."));
    return;
  }

  const backups = getBackups(backupRoot);

  if (backups.length === 0) {
    console.log(chalk.yellow("No backups found."));
    return;
  }

  console.log(chalk.bold(`\n📦 ${backups.length} backup${backups.length === 1 ? "" : "s"} available:\n`));

  for (const backup of backups) {
    console.log(`  ${chalk.cyan(formatDate(backup.date))}`);
    console.log(chalk.gray(`    ${backup.files.join(", ")}`));
    console.log(chalk.gray(`    ${backup.path}`));
    console.log("");
  }

  console.log(chalk.gray("Run `upshift rollback` to restore the latest backup."));
  console.log(chalk.gray("Run `upshift rollback -i` to select a specific backup.\n"));
}
