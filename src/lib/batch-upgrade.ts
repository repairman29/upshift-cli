import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "fs";
import path from "path";
import semver from "semver";
import {
  detectPackageManager,
  getOutdatedPackages,
  installPackage,
  runTests,
  getLockfileName,
  type PackageManager,
} from "./package-manager.js";
import { loadConfig, parseTestCommand } from "./config.js";
import { assessRisk } from "./explain.js";
import { tryRollback } from "./upgrade.js";
import { detectEcosystem } from "./ecosystem.js";
import { getPythonOutdated, getRubyOutdated, getGoOutdated } from "./ecosystem.js";
import { runCommand } from "./exec.js";
import { runPythonUpgrade, createBackupPython, tryRollbackPython, getTestCommandPython } from "./upgrade-python.js";
import { runRubyUpgrade, createBackupRuby, tryRollbackRuby, getTestCommandRuby } from "./upgrade-ruby.js";
import { runGoUpgrade, createBackupGo, tryRollbackGo, getTestCommandGo } from "./upgrade-go.js";

export type BatchUpgradeOptions = {
  cwd: string;
  mode: "all" | "minor" | "patch";
  dryRun?: boolean;
  yes?: boolean;
  skipTests?: boolean;
};

export type UpgradeCandidate = {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  upgradeType: "major" | "minor" | "patch";
  target: string;
};

export async function runBatchUpgrade(options: BatchUpgradeOptions): Promise<void> {
  const ecosystem = detectEcosystem(options.cwd);
  if (ecosystem === "python") {
    await runBatchUpgradePython(options);
    return;
  }
  if (ecosystem === "ruby") {
    await runBatchUpgradeRuby(options);
    return;
  }
  if (ecosystem === "go") {
    await runBatchUpgradeGo(options);
    return;
  }

  const spinner = ora("Scanning for upgradeable dependencies...").start();

  try {
    const packageManager = detectPackageManager(options.cwd);
    spinner.text = `Using ${packageManager}...`;

    // Get outdated packages
    const outdatedRaw = await getOutdatedPackages(options.cwd, packageManager);
    const outdated: UpgradeCandidate[] = outdatedRaw.map((pkg) => ({
      ...pkg,
      upgradeType: getUpgradeType(pkg.current, pkg.latest),
      target: pkg.latest,
    }));

    if (outdated.length === 0) {
      spinner.succeed("All dependencies are up to date!");
      return;
    }

    // Filter based on mode
    let candidates = filterCandidates(outdated, options.mode);

    // Upgrade policy: remove candidates blocked by risk level
    const config = loadConfig(options.cwd);
    const blockRisk = config.upgradePolicy?.blockRisk;
    if (blockRisk && blockRisk.length > 0) {
      const before = candidates.length;
      const allowed: UpgradeCandidate[] = [];
      for (const pkg of candidates) {
        const risk = await assessRisk(options.cwd, pkg.name, pkg.current, pkg.target);
        if (risk.level === "low" || !blockRisk.includes(risk.level as "high" | "medium")) allowed.push(pkg);
      }
      candidates = allowed;
      if (before > candidates.length) {
        process.stdout.write(
          chalk.gray(
            `Skipped ${before - candidates.length} upgrade(s) due to upgrade policy (blockRisk: ${blockRisk.join(", ")}).\n`
          )
        );
      }
    }

    if (candidates.length === 0) {
      spinner.succeed(`No ${options.mode} updates available`);
      process.stdout.write(
        chalk.gray(`Found ${outdated.length} outdated packages, but none match the ${options.mode} criteria.\n`)
      );
      process.stdout.write(chalk.gray("Run `upshift upgrade --all` to see all available upgrades.\n"));
      return;
    }

    spinner.succeed(`Found ${candidates.length} ${options.mode} upgrades (${packageManager})`);

    // Display candidates
    process.stdout.write(chalk.bold("\nPackages to upgrade:\n\n"));

    for (const pkg of candidates) {
      const typeColor =
        pkg.upgradeType === "major" ? chalk.red : pkg.upgradeType === "minor" ? chalk.yellow : chalk.green;

      process.stdout.write(
        `  ${chalk.cyan(pkg.name.padEnd(30))} ${pkg.current.padEnd(12)} → ${typeColor(pkg.target.padEnd(12))} ${chalk.gray(`(${pkg.upgradeType})`)}\n`
      );
    }

    // Dry run mode
    if (options.dryRun) {
      process.stdout.write(chalk.gray("\nDry run - no changes applied.\n"));
      process.stdout.write(chalk.gray("Remove --dry-run to apply these upgrades.\n"));
      return;
    }

    // Confirm
    if (!options.yes) {
      const confirmed = await confirmUpgrade(candidates.length);
      if (!confirmed) {
        process.stdout.write(chalk.gray("\nNo changes applied.\n"));
        return;
      }
    }

    // Create backup
    const backupDir = createBackup(options.cwd, packageManager);
    process.stdout.write(chalk.gray(`\nBackup created: ${backupDir}\n\n`));

    // Upgrade packages one by one
    let succeeded = 0;
    let failed = 0;

    for (const pkg of candidates) {
      const pkgSpinner = ora(`Upgrading ${pkg.name}...`).start();

      try {
        await installPackage(options.cwd, pkg.name, pkg.target, packageManager);
        pkgSpinner.succeed(`${pkg.name} ${pkg.current} → ${pkg.target}`);
        succeeded++;
      } catch {
        pkgSpinner.fail(`${pkg.name} failed to upgrade`);
        failed++;
      }
    }

    // Run tests if not skipped
    if (!options.skipTests) {
      const customTestCommand = parseTestCommand(config.testCommand);
      const testScript = getTestScript(options.cwd);
      if (customTestCommand || testScript) {
        const testSpinner = ora("Running tests...").start();
        try {
          await runTests(options.cwd, packageManager);
          testSpinner.succeed("Tests passed");
        } catch {
          testSpinner.stop();
          process.stdout.write(chalk.red("Tests failed after the batch upgrade.\n"));
          const rolledBack = await tryRollback(options.cwd, packageManager);
          if (rolledBack) {
            process.stdout.write(
              chalk.green("Rolled back to the previous state (package.json and lockfile restored).\n")
            );
          }
          process.stdout.write(
            chalk.gray(
              "Next: Upgrade one package at a time with `upshift upgrade <package>` to find the breaking upgrade, or run `upshift explain <package> --ai` for breaking-change guidance.\n"
            )
          );
          process.exit(1);
        }
      }
    }

    // Summary
    process.stdout.write(chalk.bold("\nUpgrade Summary:\n"));
    process.stdout.write(chalk.green(`  ✔ ${succeeded} packages upgraded\n`));
    if (failed > 0) {
      process.stdout.write(chalk.red(`  ✖ ${failed} packages failed\n`));
    }
    process.stdout.write(chalk.gray("\nTip: Run `upshift rollback` to undo all changes.\n"));
  } catch (error) {
    spinner.fail("Batch upgrade failed");
    throw error;
  }
}

async function runBatchUpgradePython(options: BatchUpgradeOptions): Promise<void> {
  const spinner = ora("Scanning for outdated Python packages...").start();
  try {
    const outdatedRaw = await getPythonOutdated(options.cwd);
    const outdated: UpgradeCandidate[] = outdatedRaw.map((pkg) => ({
      ...pkg,
      upgradeType: getUpgradeType(pkg.current, pkg.latest),
      target: pkg.latest,
    }));
    if (outdated.length === 0) {
      spinner.succeed("All Python dependencies are up to date!");
      return;
    }
    const candidates = filterCandidates(outdated, options.mode);
    if (candidates.length === 0) {
      spinner.succeed(`No ${options.mode} updates available`);
      process.stdout.write(
        chalk.gray(`Found ${outdated.length} outdated packages, but none match the ${options.mode} criteria.\n`)
      );
      return;
    }
    spinner.succeed(`Found ${candidates.length} ${options.mode} upgrades (Python)`);
    process.stdout.write(chalk.bold("\nPackages to upgrade:\n\n"));
    for (const pkg of candidates) {
      const typeColor =
        pkg.upgradeType === "major" ? chalk.red : pkg.upgradeType === "minor" ? chalk.yellow : chalk.green;
      process.stdout.write(
        `  ${chalk.cyan(pkg.name.padEnd(30))} ${pkg.current.padEnd(12)} → ${typeColor(pkg.target.padEnd(12))} ${chalk.gray(`(${pkg.upgradeType})`)}\n`
      );
    }
    if (options.dryRun) {
      process.stdout.write(chalk.gray("\nDry run - no changes applied.\n"));
      return;
    }
    if (!options.yes) {
      const confirmed = await confirmUpgrade(candidates.length);
      if (!confirmed) {
        process.stdout.write(chalk.gray("\nNo changes applied.\n"));
        return;
      }
    }
    const backupDir = createBackupPython(options.cwd);
    process.stdout.write(chalk.gray(`\nBackup created: ${backupDir}\n\n`));
    let succeeded = 0;
    let failed = 0;
    for (const pkg of candidates) {
      const pkgSpinner = ora(`Upgrading ${pkg.name}...`).start();
      try {
        await runPythonUpgrade({
          cwd: options.cwd,
          packageName: pkg.name,
          toVersion: pkg.target,
          dryRun: false,
          yes: true,
          skipTests: true,
        });
        pkgSpinner.succeed(`${pkg.name} ${pkg.current} → ${pkg.target}`);
        succeeded++;
      } catch {
        pkgSpinner.fail(`${pkg.name} failed to upgrade`);
        failed++;
      }
    }
    if (!options.skipTests) {
      const parts = getTestCommandPython(options.cwd);
      if (parts && parts.length > 0) {
        const testSpinner = ora("Running tests...").start();
        try {
          await runCommand(parts[0], parts.slice(1), options.cwd);
          testSpinner.succeed("Tests passed");
        } catch {
          testSpinner.fail("Tests failed - rolling back all upgrades");
          tryRollbackPython(options.cwd, backupDir);
          throw new Error("Tests failed after batch upgrade; changes rolled back");
        }
      }
    }
    process.stdout.write(chalk.bold("\nUpgrade Summary:\n"));
    process.stdout.write(chalk.green(`  ✔ ${succeeded} packages upgraded\n`));
    if (failed > 0) process.stdout.write(chalk.red(`  ✖ ${failed} packages failed\n`));
    process.stdout.write(chalk.gray("\nTip: Run `upshift rollback` to undo all changes.\n"));
  } catch (error) {
    spinner.fail("Batch upgrade failed");
    throw error;
  }
}

async function runBatchUpgradeRuby(options: BatchUpgradeOptions): Promise<void> {
  const spinner = ora("Scanning for outdated Ruby gems...").start();
  try {
    const outdatedRaw = await getRubyOutdated(options.cwd);
    const outdated: UpgradeCandidate[] = outdatedRaw.map((pkg) => ({
      ...pkg,
      upgradeType: getUpgradeType(pkg.current, pkg.latest),
      target: pkg.latest,
    }));
    if (outdated.length === 0) {
      spinner.succeed("All Ruby dependencies are up to date!");
      return;
    }
    const candidates = filterCandidates(outdated, options.mode);
    if (candidates.length === 0) {
      spinner.succeed(`No ${options.mode} updates available`);
      process.stdout.write(
        chalk.gray(`Found ${outdated.length} outdated packages, but none match the ${options.mode} criteria.\n`)
      );
      return;
    }
    spinner.succeed(`Found ${candidates.length} ${options.mode} upgrades (Ruby)`);
    process.stdout.write(chalk.bold("\nPackages to upgrade:\n\n"));
    for (const pkg of candidates) {
      const typeColor =
        pkg.upgradeType === "major" ? chalk.red : pkg.upgradeType === "minor" ? chalk.yellow : chalk.green;
      process.stdout.write(
        `  ${chalk.cyan(pkg.name.padEnd(30))} ${pkg.current.padEnd(12)} → ${typeColor(pkg.target.padEnd(12))} ${chalk.gray(`(${pkg.upgradeType})`)}\n`
      );
    }
    if (options.dryRun) {
      process.stdout.write(chalk.gray("\nDry run - no changes applied.\n"));
      return;
    }
    if (!options.yes) {
      const confirmed = await confirmUpgrade(candidates.length);
      if (!confirmed) {
        process.stdout.write(chalk.gray("\nNo changes applied.\n"));
        return;
      }
    }
    const backupDir = createBackupRuby(options.cwd);
    process.stdout.write(chalk.gray(`\nBackup created: ${backupDir}\n\n`));
    let succeeded = 0;
    let failed = 0;
    for (const pkg of candidates) {
      const pkgSpinner = ora(`Upgrading ${pkg.name}...`).start();
      try {
        await runRubyUpgrade({
          cwd: options.cwd,
          packageName: pkg.name,
          toVersion: pkg.target,
          dryRun: false,
          yes: true,
          skipTests: true,
        });
        pkgSpinner.succeed(`${pkg.name} ${pkg.current} → ${pkg.target}`);
        succeeded++;
      } catch {
        pkgSpinner.fail(`${pkg.name} failed to upgrade`);
        failed++;
      }
    }
    if (!options.skipTests) {
      const parts = await getTestCommandRuby(options.cwd);
      if (parts && parts.length > 0) {
        const testSpinner = ora("Running tests...").start();
        try {
          await runCommand(parts[0], parts.slice(1), options.cwd);
          testSpinner.succeed("Tests passed");
        } catch {
          testSpinner.fail("Tests failed - rolling back all upgrades");
          tryRollbackRuby(options.cwd, backupDir);
          throw new Error("Tests failed after batch upgrade; changes rolled back");
        }
      }
    }
    process.stdout.write(chalk.bold("\nUpgrade Summary:\n"));
    process.stdout.write(chalk.green(`  ✔ ${succeeded} packages upgraded\n`));
    if (failed > 0) process.stdout.write(chalk.red(`  ✖ ${failed} packages failed\n`));
    process.stdout.write(chalk.gray("\nTip: Run `upshift rollback` to undo all changes.\n"));
  } catch (error) {
    spinner.fail("Batch upgrade failed");
    throw error;
  }
}

async function runBatchUpgradeGo(options: BatchUpgradeOptions): Promise<void> {
  const spinner = ora("Scanning for outdated Go modules...").start();
  try {
    const outdatedRaw = await getGoOutdated(options.cwd);
    const outdated: UpgradeCandidate[] = outdatedRaw.map((pkg) => ({
      ...pkg,
      upgradeType: getUpgradeType(pkg.current, pkg.latest),
      target: pkg.latest,
    }));
    if (outdated.length === 0) {
      spinner.succeed("All Go dependencies are up to date!");
      return;
    }
    const candidates = filterCandidates(outdated, options.mode);
    if (candidates.length === 0) {
      spinner.succeed(`No ${options.mode} updates available`);
      process.stdout.write(
        chalk.gray(`Found ${outdated.length} outdated packages, but none match the ${options.mode} criteria.\n`)
      );
      return;
    }
    spinner.succeed(`Found ${candidates.length} ${options.mode} upgrades (Go)`);
    process.stdout.write(chalk.bold("\nPackages to upgrade:\n\n"));
    for (const pkg of candidates) {
      const typeColor =
        pkg.upgradeType === "major" ? chalk.red : pkg.upgradeType === "minor" ? chalk.yellow : chalk.green;
      process.stdout.write(
        `  ${chalk.cyan(pkg.name.padEnd(30))} ${pkg.current.padEnd(12)} → ${typeColor(pkg.target.padEnd(12))} ${chalk.gray(`(${pkg.upgradeType})`)}\n`
      );
    }
    if (options.dryRun) {
      process.stdout.write(chalk.gray("\nDry run - no changes applied.\n"));
      return;
    }
    if (!options.yes) {
      const confirmed = await confirmUpgrade(candidates.length);
      if (!confirmed) {
        process.stdout.write(chalk.gray("\nNo changes applied.\n"));
        return;
      }
    }
    const backupDir = createBackupGo(options.cwd);
    process.stdout.write(chalk.gray(`\nBackup created: ${backupDir}\n\n`));
    let succeeded = 0;
    let failed = 0;
    for (const pkg of candidates) {
      const pkgSpinner = ora(`Upgrading ${pkg.name}...`).start();
      try {
        await runGoUpgrade({
          cwd: options.cwd,
          packageName: pkg.name,
          toVersion: pkg.target,
          dryRun: false,
          yes: true,
          skipTests: true,
        });
        pkgSpinner.succeed(`${pkg.name} ${pkg.current} → ${pkg.target}`);
        succeeded++;
      } catch {
        pkgSpinner.fail(`${pkg.name} failed to upgrade`);
        failed++;
      }
    }
    if (!options.skipTests) {
      const parts = getTestCommandGo(options.cwd);
      if (parts && parts.length > 0) {
        const testSpinner = ora("Running tests...").start();
        try {
          await runCommand(parts[0], parts.slice(1), options.cwd);
          testSpinner.succeed("Tests passed");
        } catch {
          testSpinner.fail("Tests failed - rolling back all upgrades");
          tryRollbackGo(options.cwd, backupDir);
          throw new Error("Tests failed after batch upgrade; changes rolled back");
        }
      }
    }
    process.stdout.write(chalk.bold("\nUpgrade Summary:\n"));
    process.stdout.write(chalk.green(`  ✔ ${succeeded} packages upgraded\n`));
    if (failed > 0) process.stdout.write(chalk.red(`  ✖ ${failed} packages failed\n`));
    process.stdout.write(chalk.gray("\nTip: Run `upshift rollback` to undo all changes.\n"));
  } catch (error) {
    spinner.fail("Batch upgrade failed");
    throw error;
  }
}

function getUpgradeType(current: string, target: string): "major" | "minor" | "patch" {
  const currentClean = semver.coerce(current)?.version;
  const targetClean = semver.coerce(target)?.version;

  if (!currentClean || !targetClean) return "major";

  if (semver.major(targetClean) > semver.major(currentClean)) return "major";
  if (semver.minor(targetClean) > semver.minor(currentClean)) return "minor";
  return "patch";
}

function filterCandidates(candidates: UpgradeCandidate[], mode: "all" | "minor" | "patch"): UpgradeCandidate[] {
  if (mode === "all") {
    return candidates;
  }

  if (mode === "minor") {
    return candidates
      .filter((c) => c.upgradeType !== "major")
      .map((c) => ({
        ...c,
        target: c.wanted,
      }));
  }

  if (mode === "patch") {
    return candidates
      .filter((c) => c.upgradeType === "patch")
      .map((c) => ({
        ...c,
        target: c.wanted,
      }));
  }

  return candidates;
}

function createBackup(cwd: string, pm: PackageManager): string {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, stamp);
  mkdirSync(backupDir, { recursive: true });

  // Always backup package.json and the relevant lockfile
  const files = ["package.json", getLockfileName(pm)];
  for (const file of files) {
    const src = path.join(cwd, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(backupDir, file));
    }
  }

  return backupDir;
}

function getTestScript(cwd: string): string | null {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  return pkg.scripts?.test ?? null;
}

async function confirmUpgrade(count: number): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(chalk.yellow(`\nUpgrade ${count} packages? [y/N] `), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
