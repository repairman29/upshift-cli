import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import semver from "semver";
import { runCommand } from "./exec.js";
import { loadConfig, parseTestCommand } from "./config.js";
import { assessRisk } from "./explain.js";
import { detectEcosystem } from "./ecosystem.js";
import { runPythonUpgrade } from "./upgrade-python.js";
import { runRubyUpgrade } from "./upgrade-ruby.js";
import { runGoUpgrade } from "./upgrade-go.js";
import { emitAuditEvent } from "./audit-log.js";
import {
  detectPackageManager,
  installPackage,
  getLockfileName,
  runTests as runPmTests,
  reinstallDependencies,
  getAddCommand,
} from "./package-manager.js";

export type UpgradeOptions = {
  cwd: string;
  packageName: string;
  toVersion?: string;
  dryRun: boolean;
  yes?: boolean;
  skipTests?: boolean;
};

export async function runUpgrade(options: UpgradeOptions): Promise<void> {
  const ecosystem = detectEcosystem(options.cwd);
  if (ecosystem === "python") {
    await runPythonUpgrade({
      cwd: options.cwd,
      packageName: options.packageName,
      toVersion: options.toVersion,
      dryRun: options.dryRun,
      yes: options.yes,
      skipTests: options.skipTests,
    });
    return;
  }
  if (ecosystem === "ruby") {
    await runRubyUpgrade({
      cwd: options.cwd,
      packageName: options.packageName,
      toVersion: options.toVersion,
      dryRun: options.dryRun,
      yes: options.yes,
      skipTests: options.skipTests,
    });
    return;
  }
  if (ecosystem === "go") {
    await runGoUpgrade({
      cwd: options.cwd,
      packageName: options.packageName,
      toVersion: options.toVersion,
      dryRun: options.dryRun,
      yes: options.yes,
      skipTests: options.skipTests,
    });
    return;
  }

  const spinner = ora(`Upgrading ${options.packageName}...`).start();
  let packageManager: import("./package-manager.js").PackageManager = "npm";
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  try {
    packageManager = detectPackageManager(options.cwd);

    const target = options.toVersion ?? "latest";
    const config = loadConfig(options.cwd);
    const customTestCommand = parseTestCommand(config.testCommand);
    const approval = config.approval ?? { mode: "prompt" as const, requireFor: ["major"] };
    const requireApprovalForMajor = (approval.requireFor ?? ["major"]).includes("major");
    const approvalMode = approval.mode ?? "prompt";

    currentVersion = getCurrentVersion(options.cwd, options.packageName);
    targetVersion = target === "latest" ? await getLatestVersion(options.packageName, options.cwd) : target;
    const isMajor = currentVersion && targetVersion && isMajorBump(currentVersion, targetVersion);

    // Upgrade policy: block upgrades above configured risk level
    const blockRisk = config.upgradePolicy?.blockRisk;
    if (!options.dryRun && blockRisk && blockRisk.length > 0 && targetVersion) {
      const risk = await assessRisk(options.cwd, options.packageName, currentVersion ?? undefined, targetVersion);
      if (risk.level !== "low" && blockRisk.includes(risk.level as "high" | "medium")) {
        spinner.fail(
          `Upgrade blocked by policy (risk: ${risk.level}). Set upgradePolicy.blockRisk in .upshiftrc.json or use -y to override.`
        );
        risk.reasons.forEach((r) => {
          process.stdout.write(chalk.gray(`  - ${r}\n`));
        });
        process.exit(1);
      }
    }

    if (!options.dryRun && !options.yes && !config.autoConfirm && requireApprovalForMajor && isMajor) {
      if (approvalMode === "webhook" && approval.webhookUrl) {
        spinner.text = "Waiting for webhook approval...";
        const approved = await callApprovalWebhook(approval.webhookUrl, {
          packageName: options.packageName,
          currentVersion: currentVersion ?? undefined,
          targetVersion: targetVersion ?? undefined,
          cwd: options.cwd,
        });
        if (!approved) {
          spinner.fail("Upgrade rejected by webhook.");
          process.exit(1);
        }
        spinner.start(`Upgrading ${options.packageName}...`);
      } else if (approvalMode === "prompt") {
        if (process.stdin.isTTY) {
          spinner.stop();
          const approved = await promptApproval(options.packageName, currentVersion ?? "?", targetVersion ?? "?");
          if (!approved) {
            process.stdout.write(chalk.gray("Upgrade skipped.\n"));
            return;
          }
          spinner.start(`Upgrading ${options.packageName}...`);
        } else {
          spinner.fail(
            "Major upgrade requires approval (non-interactive). Use -y to apply anyway, or set approval.mode: none in .upshiftrc.json"
          );
          process.exit(1);
        }
      }
    }

    const backupDir = createBackup(options.cwd, packageManager);

    if (options.dryRun) {
      spinner.succeed("Dry run complete");
      const addCmd = getAddCommand(packageManager, options.packageName, target === "latest" ? undefined : target);
      process.stdout.write(
        [
          `Package manager: ${packageManager}`,
          `Command: ${addCmd}`,
          `Backup dir: ${backupDir}`,
          "Tests: " +
            (customTestCommand
              ? customTestCommand.join(" ")
              : getTestScript(options.cwd)
                ? `${packageManager} test`
                : "not configured"),
        ].join("\n") + "\n"
      );
      if (isMajor) {
        process.stdout.write(
          chalk.gray(
            "Tip: Major upgrade. Run `upshift explain " +
              options.packageName +
              " --risk` or `--ai` first. See docs/upgrade-what-to-test.md for what to anticipate.\n"
          )
        );
      }
      return;
    }

    await installPackage(options.cwd, options.packageName, target === "latest" ? undefined : target, packageManager);

    if (isMajor) {
      process.stdout.write(
        chalk.gray(
          "Major bump: the dependency is updated; codemods are not applied automatically. Run `" +
            `upshift migrate ${options.packageName} --list` +
            "` for templates (when available), or `" +
            `upshift explain ${options.packageName} --ai` +
            "` for breaking-change guidance.\n"
        )
      );
    }

    const testScript = getTestScript(options.cwd);
    let testsPassed = false;
    if (customTestCommand || testScript) {
      process.stdout.write(chalk.gray("Running tests...\n"));
      try {
        await runPmTests(options.cwd, packageManager);
        testsPassed = true;
        process.stdout.write(chalk.green("Tests passed.\n"));
      } catch {
        spinner.stop();
        process.stdout.write(chalk.red(`Tests failed after upgrading ${options.packageName}.\n`));
        const rolledBack = await tryRollback(options.cwd, packageManager);
        if (rolledBack) {
          process.stdout.write(
            chalk.green("Rolled back to the previous state (package.json and lockfile restored).\n")
          );
        }
        await emitAuditEvent("upgrade", "package", options.packageName, {
          from_version: currentVersion,
          to_version: targetVersion,
          outcome: "tests_failed",
        });
        reportUpgradeSignal({
          packageName: options.packageName,
          fromVersion: currentVersion ?? undefined,
          toVersion: targetVersion ?? "",
          outcome: "failure",
          testsPassed: false,
        }).catch(() => {});
        process.stdout.write(
          chalk.gray(
            "Next: Run `upshift explain " +
              options.packageName +
              " --ai` for breaking changes, or `upshift fix " +
              options.packageName +
              "` for AI-suggested code fixes.\n"
          )
        );
        process.exit(1);
      }
    } else {
      process.stdout.write(
        chalk.yellow("No test script configured. Skipping tests; no rollback on breakage.\n") +
          chalk.gray(
            'Add a "test" script in package.json (or "testCommand" in .upshiftrc.json) so Upshift can roll back if an upgrade breaks.\n'
          )
      );
    }

    if (process.env.UPSHIFT_RECORD_OUTCOMES === "1") {
      recordOutcome(options.cwd, {
        packageName: options.packageName,
        fromVersion: currentVersion ?? undefined,
        toVersion: targetVersion ?? undefined,
        testsPassed,
      });
    }

    await emitAuditEvent("upgrade", "package", options.packageName, {
      from_version: currentVersion,
      to_version: targetVersion,
      outcome: testsPassed ? "success" : "tests_failed",
    });

    // Non-fatally report upgrade signal for community confidence data
    reportUpgradeSignal({
      packageName: options.packageName,
      fromVersion: currentVersion ?? undefined,
      toVersion: targetVersion ?? "",
      outcome: testsPassed ? "success" : "partial",
      testsPassed: testsPassed ?? null,
    }).catch(() => {});

    spinner.succeed("Upgrade complete");
  } catch (error) {
    spinner.fail("Upgrade failed");
    await tryRollback(options.cwd, packageManager);
    reportUpgradeSignal({
      packageName: options.packageName,
      fromVersion: currentVersion ?? undefined,
      toVersion: targetVersion ?? "",
      outcome: "failure",
      testsPassed: false,
    }).catch(() => {});
    throw error;
  }
}

function createBackup(cwd: string, pm: import("./package-manager.js").PackageManager): string {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, stamp);
  mkdirSync(backupDir, { recursive: true });

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

export async function tryRollback(cwd: string, pm: import("./package-manager.js").PackageManager): Promise<boolean> {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  if (!existsSync(backupRoot)) return false;

  const entries = readdirSafe(backupRoot).sort().reverse();
  const latest = entries[0];
  if (!latest) return false;

  process.stdout.write(chalk.gray("Rolling back to the previous state...\n"));
  const backupDir = path.join(backupRoot, latest);
  const files = ["package.json", getLockfileName(pm)];
  for (const file of files) {
    const src = path.join(backupDir, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(cwd, file));
    }
  }

  try {
    await reinstallDependencies(cwd, pm);
  } catch {
    process.stdout.write(chalk.red(`Rollback ${pm} install failed. Please reinstall manually.\n`));
  }
  return true;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function getCurrentVersion(cwd: string, packageName: string): string | null {
  const pkgPath = path.join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const spec = deps[packageName];
    if (!spec) return null;
    const coerced = semver.coerce(spec);
    return coerced?.version ?? null;
  } catch {
    return null;
  }
}

async function getLatestVersion(packageName: string, cwd: string): Promise<string | null> {
  try {
    const result = await runCommand("npm", ["view", packageName, "version"], cwd, [0]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function isMajorBump(current: string, target: string): boolean {
  const c = semver.coerce(current)?.version;
  const t = semver.coerce(target)?.version;
  if (!c || !t) return true;
  return semver.major(t) > semver.major(c);
}

async function promptApproval(packageName: string, current: string, target: string): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.yellow(`Upgrade ${packageName} from ${current} to ${target} (major)? [y/N] `), (answer) => {
      rl.close();
      resolve(/^y/i.test(answer?.trim() ?? ""));
    });
  });
}

async function callApprovalWebhook(
  url: string,
  payload: { packageName: string; currentVersion?: string; targetVersion?: string; cwd: string }
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "upgrade_proposed",
        ...payload,
        timestamp: new Date().toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function recordOutcome(
  cwd: string,
  outcome: {
    packageName: string;
    fromVersion?: string;
    toVersion?: string;
    testsPassed: boolean;
  }
): void {
  try {
    const dir = path.join(cwd, ".upshift");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "outcomes.json");
    const existing: unknown[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    existing.push({
      ...outcome,
      recordedAt: new Date().toISOString(),
    });
    writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/** Non-fatally post an upgrade outcome to the Upshift confidence API */
export async function reportUpgradeSignal(opts: {
  packageName: string;
  fromVersion: string | undefined;
  toVersion: string;
  outcome: "success" | "failure" | "partial";
  testsPassed: boolean | null;
}): Promise<void> {
  const apiBase = process.env.UPSHIFT_API_URL || "https://upshiftai.dev";
  const apiToken = process.env.UPSHIFT_API_TOKEN;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;

  try {
    await fetch(`${apiBase}/api/confidence/signal`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        package: opts.packageName,
        fromVersion: opts.fromVersion,
        toVersion: opts.toVersion,
        outcome: opts.outcome,
        testsPassed: opts.testsPassed,
      }),
    });
  } catch {
    // Non-fatal — never block the user's workflow
  }
}
