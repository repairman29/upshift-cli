import chalk from "chalk";
import ora from "ora";
import { checkbox, select, confirm } from "@inquirer/prompts";
import { existsSync, readFileSync } from "fs";
import path from "path";
import semver from "semver";
import { runCommand } from "./exec.js";
import { loadConfig, parseTestCommand } from "./config.js";
import { runTests as runProjectTests } from "./package-manager.js";

export type InteractiveOptions = {
  cwd: string;
};

type PackageInfo = {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  upgradeType: "major" | "minor" | "patch";
  hasVuln: boolean;
};

export async function runInteractive(options: InteractiveOptions): Promise<void> {
  console.clear();
  console.log(chalk.bold.cyan("\n  ⬆️  Upshift Interactive Mode\n"));

  const spinner = ora("Scanning dependencies...").start();

  try {
    // Get outdated packages
    const outdated = await getOutdatedPackages(options.cwd);
    const vulns = await getVulnerablePackages(options.cwd);

    if (outdated.length === 0) {
      spinner.succeed("All dependencies are up to date!");
      return;
    }

    // Mark packages with vulnerabilities
    const packages: PackageInfo[] = outdated.map((pkg) => ({
      ...pkg,
      hasVuln: vulns.has(pkg.name),
    }));

    spinner.succeed(`Found ${packages.length} outdated packages`);

    // Group by upgrade type
    const major = packages.filter((p) => p.upgradeType === "major");
    const minor = packages.filter((p) => p.upgradeType === "minor");
    const patch = packages.filter((p) => p.upgradeType === "patch");
    const withVulns = packages.filter((p) => p.hasVuln);

    // Show summary
    console.log("");
    console.log(chalk.gray("  Summary:"));
    if (major.length > 0) console.log(chalk.red(`    ${major.length} major updates`));
    if (minor.length > 0) console.log(chalk.yellow(`    ${minor.length} minor updates`));
    if (patch.length > 0) console.log(chalk.green(`    ${patch.length} patch updates`));
    if (withVulns.length > 0) console.log(chalk.red(`    ${withVulns.length} with vulnerabilities ⚠️`));
    console.log("");

    // Ask what to do
    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Select packages to upgrade", value: "select" },
        { name: `Upgrade all safe updates (${minor.length + patch.length} packages)`, value: "safe" },
        { name: `Upgrade all patches only (${patch.length} packages)`, value: "patch" },
        { name: `Fix vulnerabilities first (${withVulns.length} packages)`, value: "vulns" },
        { name: "Upgrade everything to latest", value: "all" },
        { name: "Exit", value: "exit" },
      ],
    });

    if (action === "exit") {
      console.log(chalk.gray("\n  Goodbye!\n"));
      return;
    }

    let selectedPackages: PackageInfo[] = [];

    if (action === "select") {
      selectedPackages = await selectPackages(packages);
    } else if (action === "safe") {
      selectedPackages = [...minor, ...patch];
    } else if (action === "patch") {
      selectedPackages = patch;
    } else if (action === "vulns") {
      selectedPackages = withVulns;
    } else if (action === "all") {
      selectedPackages = packages;
    }

    if (selectedPackages.length === 0) {
      console.log(chalk.gray("\n  No packages selected.\n"));
      return;
    }

    // Show selected packages
    console.log(chalk.bold("\n  Selected packages:\n"));
    for (const pkg of selectedPackages) {
      const typeColor =
        pkg.upgradeType === "major" ? chalk.red : pkg.upgradeType === "minor" ? chalk.yellow : chalk.green;
      const vulnBadge = pkg.hasVuln ? chalk.red(" ⚠️ VULN") : "";
      console.log(
        `    ${chalk.cyan(pkg.name.padEnd(25))} ${pkg.current.padEnd(10)} → ${typeColor(pkg.latest.padEnd(10))}${vulnBadge}`
      );
    }
    console.log("");

    // Confirm
    const proceed = await confirm({
      message: `Upgrade ${selectedPackages.length} packages?`,
      default: true,
    });

    if (!proceed) {
      console.log(chalk.gray("\n  Cancelled.\n"));
      return;
    }

    // Ask about AI analysis
    const useAI = await confirm({
      message: "Run AI analysis for major upgrades? (costs 1 credit each)",
      default: false,
    });

    // Upgrade packages
    await upgradePackages(options.cwd, selectedPackages, useAI);
  } catch (error) {
    spinner.fail("Error in interactive mode");
    throw error;
  }
}

async function getOutdatedPackages(cwd: string): Promise<Omit<PackageInfo, "hasVuln">[]> {
  const result = await runCommand("npm", ["outdated", "--json"], cwd, [0, 1]);
  const stdout = result.stdout.trim();
  if (!stdout) return [];

  const parsed = JSON.parse(stdout) as Record<string, { current: string; wanted: string; latest: string }>;

  return Object.entries(parsed).map(([name, info]) => ({
    name,
    current: info.current,
    wanted: info.wanted,
    latest: info.latest,
    upgradeType: getUpgradeType(info.current, info.latest),
  }));
}

async function getVulnerablePackages(cwd: string): Promise<Set<string>> {
  try {
    const result = await runCommand("npm", ["audit", "--json"], cwd, [0, 1, 2]);
    const stdout = result.stdout.trim();
    if (!stdout) return new Set();

    const parsed = JSON.parse(stdout) as {
      vulnerabilities?: Record<string, unknown>;
    };

    return new Set(Object.keys(parsed.vulnerabilities ?? {}));
  } catch {
    return new Set();
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

async function selectPackages(packages: PackageInfo[]): Promise<PackageInfo[]> {
  const choices = packages.map((pkg) => {
    const typeColor =
      pkg.upgradeType === "major" ? chalk.red : pkg.upgradeType === "minor" ? chalk.yellow : chalk.green;
    const vulnBadge = pkg.hasVuln ? chalk.red(" ⚠️") : "";
    const label = `${pkg.name.padEnd(25)} ${pkg.current.padEnd(10)} → ${typeColor(pkg.latest.padEnd(10))}${vulnBadge}`;

    return {
      name: label,
      value: pkg.name,
      checked: pkg.hasVuln || pkg.upgradeType !== "major", // Pre-select safe updates and vulns
    };
  });

  const selected = await checkbox({
    message: "Select packages to upgrade (space to toggle, enter to confirm):",
    choices,
    pageSize: 15,
  });

  return packages.filter((p) => selected.includes(p.name));
}

async function upgradePackages(cwd: string, packages: PackageInfo[], useAI: boolean): Promise<void> {
  console.log("");

  let succeeded = 0;
  let failed = 0;

  for (const pkg of packages) {
    const spinner = ora(`Upgrading ${pkg.name}...`).start();

    // AI analysis for major upgrades
    if (useAI && pkg.upgradeType === "major") {
      spinner.text = `Analyzing ${pkg.name} with AI...`;
      try {
        const { runExplain } = await import("./explain.js");
        await runExplain({
          cwd,
          packageName: pkg.name,
          fromVersion: pkg.current,
          toVersion: pkg.latest,
          ai: true,
        });
      } catch {
        // Continue even if AI fails
      }
    }

    try {
      await runCommand("npm", ["install", `${pkg.name}@${pkg.latest}`], cwd);
      spinner.succeed(`${pkg.name} ${pkg.current} → ${pkg.latest}`);
      succeeded++;
    } catch {
      spinner.fail(`${pkg.name} failed`);
      failed++;
    }
  }

  // Summary
  console.log("");
  console.log(chalk.bold("  Upgrade Summary:"));
  console.log(chalk.green(`    ✔ ${succeeded} packages upgraded`));
  if (failed > 0) {
    console.log(chalk.red(`    ✖ ${failed} packages failed`));
  }

  // Run tests
  const customTestCommand = parseTestCommand(loadConfig(cwd).testCommand);
  const testScript = getTestScript(cwd);
  if (customTestCommand || testScript) {
    console.log("");
    const runTests = await confirm({
      message: "Run tests to verify upgrades?",
      default: true,
    });

    if (runTests) {
      const testSpinner = ora("Running tests...").start();
      try {
        await runProjectTests(cwd);
        testSpinner.succeed("Tests passed!");
      } catch {
        testSpinner.fail("Tests failed - consider rolling back with `upshift rollback`");
      }
    }
  }

  console.log(chalk.gray("\n  Done! Run `upshift rollback` to undo changes.\n"));
}

function getTestScript(cwd: string): string | null {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  return pkg.scripts?.test ?? null;
}
