/**
 * Python upgrade: pip/poetry upgrade with backup, test, rollback.
 */

import chalk from "chalk";
import ora from "ora";
import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import { loadConfig } from "./config.js";

export type PythonUpgradeOptions = {
  cwd: string;
  packageName: string;
  toVersion?: string;
  dryRun: boolean;
  yes?: boolean;
  skipTests?: boolean;
};

function detectPythonPackageManager(cwd: string): "pip" | "poetry" {
  if (existsSync(path.join(cwd, "pyproject.toml"))) {
    try {
      runCommand("poetry", ["--version"], cwd, [0]);
      return "poetry";
    } catch {
      // fallback to pip
    }
  }
  return "pip";
}

export function createBackupPython(cwd: string): string {
  const backupRoot = path.join(cwd, ".upshift", "backups");
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, stamp);
  mkdirSync(backupDir, { recursive: true });

  const files = ["pyproject.toml", "poetry.lock", "requirements.txt", "requirements-dev.txt"];
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

function tryRollbackPython(cwd: string, backupDir?: string): void {
  const resolved = backupDir ?? findLatestBackup(cwd);
  if (!resolved) return;

  process.stdout.write(chalk.red("Attempting rollback...\n"));
  const files = ["pyproject.toml", "poetry.lock", "requirements.txt", "requirements-dev.txt"];
  for (const file of files) {
    const src = path.join(resolved, file);
    if (existsSync(src)) {
      copyFileSync(src, path.join(cwd, file));
    }
  }

  const pm = detectPythonPackageManager(cwd);
  if (pm === "poetry") {
    runCommand("poetry", ["install"], cwd).catch(() => {
      process.stdout.write(chalk.red("Rollback poetry install failed. Run poetry install manually.\n"));
    });
  } else if (existsSync(path.join(cwd, "requirements.txt"))) {
    runCommand("pip", ["install", "-r", "requirements.txt"], cwd).catch(() => {
      process.stdout.write(chalk.red("Rollback pip install failed. Run pip install -r requirements.txt manually.\n"));
    });
  }
}

async function getCurrentVersionPython(cwd: string, packageName: string, pm: "pip" | "poetry"): Promise<string | null> {
  try {
    if (pm === "poetry") {
      const result = await runCommand("poetry", ["show", packageName], cwd, [0, 1]);
      const m = result.stdout.match(/version\s*:\s*(\S+)/i) ?? result.stdout.match(/^(\S+)\s+(\S+)/);
      return m ? (m[2] ?? m[1]) : null;
    }
    const result = await runCommand("pip", ["show", packageName], cwd, [0, 1]);
    const m = result.stdout.match(/^Version:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function getLatestVersionPython(packageName: string, cwd: string, pm: "pip" | "poetry"): Promise<string | null> {
  try {
    if (pm === "poetry") {
      const result = await runCommand("poetry", ["show", packageName, "--latest"], cwd, [0, 1]);
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) {
        const m = line.match(/latest\s*:\s*(\S+)/i) ?? line.match(/\s+(\d+\.\d+\.\d+[\w.-]*)\s+(\d+\.\d+\.\d+)/);
        if (m) return m[1] ?? m[2];
      }
      return null;
    }
    const result = await runCommand("pip", ["index", "versions", packageName], cwd, [0, 1]);
    const m = result.stdout.match(/LATEST:\s*(\S+)/) ?? result.stdout.match(/\((\d+\.\d+\.\d+[^)]*)\)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function getTestCommandPython(cwd: string): string[] | null {
  const config = loadConfig(cwd);
  const tc = config.testCommand;
  if (tc) {
    if (Array.isArray(tc)) return tc;
    return (tc as string).trim().split(/\s+/);
  }
  if (existsSync(path.join(cwd, "pyproject.toml"))) {
    try {
      const raw = readFileSync(path.join(cwd, "pyproject.toml"), "utf8");
      if (raw.includes("[tool.pytest") || raw.includes("pytest")) return ["poetry", "run", "pytest"];
      return ["poetry", "run", "python", "-m", "pytest"];
    } catch {
      // ignore
    }
  }
  if (existsSync(path.join(cwd, "pytest.ini")) || existsSync(path.join(cwd, "setup.cfg"))) {
    return ["pytest"];
  }
  try {
    runCommand("pytest", ["--version"], cwd, [0]);
    return ["pytest"];
  } catch {
    // try make test
    if (existsSync(path.join(cwd, "Makefile"))) return ["make", "test"];
  }
  return null;
}

export async function runPythonUpgrade(options: PythonUpgradeOptions): Promise<void> {
  const spinner = ora(`Upgrading ${options.packageName} (Python)...`).start();
  const pm = detectPythonPackageManager(options.cwd);
  const target = options.toVersion ?? "latest";

  let targetVersion: string | null = target === "latest" ? null : target;
  try {
    await getCurrentVersionPython(options.cwd, options.packageName, pm);
    if (target === "latest") {
      targetVersion = await getLatestVersionPython(options.packageName, options.cwd, pm);
    }
  } catch {
    // continue
  }

  const backupDir = createBackupPython(options.cwd);

  if (options.dryRun) {
    spinner.succeed("Dry run complete");
    const cmd =
      pm === "poetry"
        ? `poetry update ${options.packageName}`
        : `pip install -U ${options.packageName}${targetVersion ? `==${targetVersion}` : ""}`;
    process.stdout.write(
      [
        `Package manager: ${pm}`,
        `Command: ${cmd}`,
        `Backup dir: ${backupDir}`,
        "Tests: pytest or config testCommand",
      ].join("\n") + "\n"
    );
    return;
  }

  try {
    if (pm === "poetry") {
      await runCommand("poetry", ["update", options.packageName], options.cwd);
    } else {
      const spec = targetVersion ? `${options.packageName}==${targetVersion}` : `${options.packageName}`;
      await runCommand("pip", ["install", "-U", spec], options.cwd);
    }
  } catch (err) {
    spinner.fail("Upgrade failed");
    tryRollbackPython(options.cwd);
    throw err;
  }

  const testCmd = getTestCommandPython(options.cwd);
  if (!options.skipTests && testCmd && testCmd.length > 0) {
    process.stdout.write(chalk.gray("Running tests...\n"));
    try {
      await runCommand(testCmd[0], testCmd.slice(1), options.cwd);
      process.stdout.write(chalk.green("Tests passed.\n"));
    } catch {
      process.stdout.write(chalk.red("Tests failed. Rolling back.\n"));
      tryRollbackPython(options.cwd);
      throw new Error("Tests failed after upgrade");
    }
  } else if (!options.skipTests) {
    process.stdout.write(chalk.gray("No test command configured. Skipping tests.\n"));
  }

  const { emitAuditEvent } = await import("./audit-log.js");
  await emitAuditEvent("upgrade", "package", options.packageName, {
    ecosystem: "python",
    outcome: "success",
  });

  spinner.succeed("Upgrade complete");
}

export { tryRollbackPython };
