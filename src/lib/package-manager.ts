import { existsSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import { loadConfig, parseTestCommand } from "./config.js";

export type PackageManager = "npm" | "yarn" | "pnpm";

export function detectPackageManager(cwd: string): PackageManager {
  const pnpmLock = path.join(cwd, "pnpm-lock.yaml");
  const yarnLock = path.join(cwd, "yarn.lock");
  const npmLock = path.join(cwd, "package-lock.json");
  const pkgJson = path.join(cwd, "package.json");

  if (existsSync(pnpmLock)) return "pnpm";
  if (existsSync(yarnLock)) return "yarn";
  if (existsSync(npmLock)) return "npm";
  if (existsSync(pkgJson)) return "npm";

  throw new Error("No package.json or lockfile found. Run in a project directory.");
}

export type OutdatedPackage = {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type?: string;
};

export async function getOutdatedPackages(cwd: string, pm?: PackageManager): Promise<OutdatedPackage[]> {
  const packageManager = pm ?? detectPackageManager(cwd);

  if (packageManager === "npm") {
    const result = await runCommand("npm", ["outdated", "--json"], cwd, [0, 1]);
    const stdout = result.stdout.trim();
    if (!stdout) return [];

    const parsed = JSON.parse(stdout) as Record<
      string,
      { current: string; wanted: string; latest: string; type?: string }
    >;

    return Object.entries(parsed).map(([name, info]) => ({
      name,
      current: info.current,
      wanted: info.wanted,
      latest: info.latest,
      type: info.type,
    }));
  }

  if (packageManager === "yarn") {
    const result = await runCommand("yarn", ["outdated", "--json"], cwd, [0, 1]);
    const stdout = result.stdout.trim();
    if (!stdout) return [];

    const entries: OutdatedPackage[] = [];
    for (const line of stdout.split("\n")) {
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          data?: { body?: Array<[string, string, string, string, string, string]> };
        };
        if (obj.type === "table" && obj.data?.body) {
          for (const row of obj.data.body) {
            entries.push({
              name: row[0],
              current: row[1],
              wanted: row[2],
              latest: row[3],
              type: row[4],
            });
          }
        }
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  }

  if (packageManager === "pnpm") {
    const result = await runCommand("pnpm", ["outdated", "--json"], cwd, [0, 1]);
    const stdout = result.stdout.trim();
    if (!stdout) return [];

    const parsed = JSON.parse(stdout) as Record<
      string,
      { current: string; wanted: string; latest: string; dependencyType?: string }
    >;

    return Object.entries(parsed).map(([name, info]) => ({
      name,
      current: info.current,
      wanted: info.wanted,
      latest: info.latest,
      type: info.dependencyType,
    }));
  }

  return [];
}

export async function installPackage(
  cwd: string,
  packageName: string,
  version?: string,
  pm?: PackageManager
): Promise<void> {
  const packageManager = pm ?? detectPackageManager(cwd);
  const spec = version ? `${packageName}@${version}` : packageName;

  if (packageManager === "npm") {
    await runCommand("npm", ["install", spec], cwd);
  } else if (packageManager === "yarn") {
    await runCommand("yarn", ["add", spec], cwd);
  } else if (packageManager === "pnpm") {
    await runCommand("pnpm", ["add", spec], cwd);
  }
}

export async function reinstallDependencies(cwd: string, pm?: PackageManager): Promise<void> {
  const packageManager = pm ?? detectPackageManager(cwd);

  if (packageManager === "npm") {
    await runCommand("npm", ["install"], cwd);
  } else if (packageManager === "yarn") {
    await runCommand("yarn", ["install"], cwd);
  } else if (packageManager === "pnpm") {
    await runCommand("pnpm", ["install"], cwd);
  }
}

export async function runTests(cwd: string, pm?: PackageManager): Promise<void> {
  const testCommand = parseTestCommand(loadConfig(cwd).testCommand);
  if (testCommand) {
    await runCommand(testCommand[0], testCommand.slice(1), cwd);
    return;
  }

  const packageManager = pm ?? detectPackageManager(cwd);

  if (packageManager === "npm") {
    await runCommand("npm", ["test"], cwd);
  } else if (packageManager === "yarn") {
    await runCommand("yarn", ["test"], cwd);
  } else if (packageManager === "pnpm") {
    await runCommand("pnpm", ["test"], cwd);
  }
}

export async function runAudit(cwd: string, pm?: PackageManager): Promise<{ stdout: string; exitCode: number }> {
  const packageManager = pm ?? detectPackageManager(cwd);

  if (packageManager === "npm") {
    const result = await runCommand("npm", ["audit", "--json"], cwd, [0, 1, 2]);
    return { stdout: result.stdout, exitCode: result.exitCode };
  }

  if (packageManager === "yarn") {
    const result = await runCommand("yarn", ["audit", "--json"], cwd, [0, 1, 2, 4, 8, 16]);
    return { stdout: result.stdout, exitCode: result.exitCode };
  }

  if (packageManager === "pnpm") {
    const result = await runCommand("pnpm", ["audit", "--json"], cwd, [0, 1, 2]);
    return { stdout: result.stdout, exitCode: result.exitCode };
  }

  return { stdout: "", exitCode: 0 };
}

export async function runAuditFix(cwd: string, pm?: PackageManager): Promise<void> {
  const packageManager = pm ?? detectPackageManager(cwd);

  if (packageManager === "npm") {
    await runCommand("npm", ["audit", "fix"], cwd);
  } else if (packageManager === "yarn") {
    // Yarn doesn't have audit fix, suggest npm
    throw new Error("Yarn doesn't support audit fix. Run: npm audit fix");
  } else if (packageManager === "pnpm") {
    // pnpm doesn't have audit fix either
    throw new Error("pnpm doesn't support audit fix. Run: npm audit fix");
  }
}

export function getLockfileName(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "package-lock.json";
    case "yarn":
      return "yarn.lock";
    case "pnpm":
      return "pnpm-lock.yaml";
  }
}

export function getInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case "npm":
      return "npm install";
    case "yarn":
      return "yarn";
    case "pnpm":
      return "pnpm install";
  }
}

export function getAddCommand(pm: PackageManager, packageName: string, version?: string): string {
  const spec = version ? `${packageName}@${version}` : packageName;

  switch (pm) {
    case "npm":
      return `npm install ${spec}`;
    case "yarn":
      return `yarn add ${spec}`;
    case "pnpm":
      return `pnpm add ${spec}`;
  }
}
