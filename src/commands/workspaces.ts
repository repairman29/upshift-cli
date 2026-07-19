import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { detectMonorepo, getAllDependencies, formatMonorepoSummary } from "../lib/monorepo.js";
import { getOutdatedPackages, detectPackageManager } from "../lib/package-manager.js";

export function workspacesCommand(): Command {
  return new Command("workspaces")
    .alias("ws")
    .description("Scan monorepo workspaces for outdated dependencies")
    .option("--json", "Output results as JSON")
    .option("--score", "Compute aggregate health score for all workspaces")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      try {
        if (options.score) {
          await runWorkspacesScore(options.cwd);
          return;
        }
        await runWorkspacesScan(options.cwd, options.json);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

async function runWorkspacesScan(cwd: string, json: boolean): Promise<void> {
  const spinner = ora("Detecting monorepo structure...").start();

  const monorepo = detectMonorepo(cwd);

  if (monorepo.type === "none") {
    spinner.info("Not a monorepo - use `upshift scan` for single packages");
    return;
  }

  spinner.succeed(`Found ${formatMonorepoSummary(monorepo)}`);

  // Get all dependencies across workspaces
  const allDeps = getAllDependencies(monorepo);

  // Scan for outdated at root level
  const pm = detectPackageManager(cwd);
  const outdatedSpinner = ora("Scanning for outdated dependencies...").start();

  let outdated: Awaited<ReturnType<typeof getOutdatedPackages>> = [];
  try {
    outdated = await getOutdatedPackages(cwd, pm);
  } catch {
    // May fail if no root dependencies
  }

  outdatedSpinner.succeed(`Found ${outdated.length} outdated packages`);

  if (json) {
    const result = {
      monorepo: {
        type: monorepo.type,
        root: monorepo.root,
        workspaceCount: monorepo.workspaces.length,
      },
      workspaces: monorepo.workspaces.map((ws) => ({
        name: ws.name,
        path: ws.path,
        dependencyCount: Object.keys({
          ...ws.packageJson.dependencies,
          ...ws.packageJson.devDependencies,
        }).length,
      })),
      outdated,
      sharedDependencies: Array.from(allDeps.entries())
        .filter(([, info]) => info.workspaces.length > 1)
        .map(([name, info]) => ({
          name,
          version: info.version,
          usedIn: info.workspaces,
        })),
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // Human-readable output
  console.log(chalk.bold("\n📦 Workspaces:\n"));

  for (const workspace of monorepo.workspaces) {
    const depCount = Object.keys({
      ...workspace.packageJson.dependencies,
      ...workspace.packageJson.devDependencies,
    }).length;

    console.log(`  ${chalk.cyan(workspace.name)}`);
    console.log(chalk.gray(`    ${workspace.path}`));
    console.log(chalk.gray(`    ${depCount} dependencies`));
  }

  // Find shared dependencies with version conflicts
  const sharedDeps = Array.from(allDeps.entries()).filter(([, info]) => info.workspaces.length > 1);

  const conflicts = sharedDeps.filter(([, info]) => info.version.includes(","));

  if (conflicts.length > 0) {
    console.log(chalk.bold.yellow("\n⚠️  Version conflicts:\n"));

    for (const [name, info] of conflicts) {
      console.log(`  ${chalk.red(name)}: ${info.version}`);
      console.log(chalk.gray(`    Used in: ${info.workspaces.join(", ")}`));
    }
  }

  // Show outdated if any
  if (outdated.length > 0) {
    console.log(chalk.bold("\n📋 Outdated dependencies:\n"));

    for (const pkg of outdated.slice(0, 10)) {
      const inWorkspaces = allDeps.get(pkg.name);
      const workspaceInfo = inWorkspaces ? chalk.gray(` (${inWorkspaces.workspaces.length} workspaces)`) : "";

      console.log(`  ${chalk.cyan(pkg.name)} ${pkg.current} → ${chalk.green(pkg.latest)}${workspaceInfo}`);
    }

    if (outdated.length > 10) {
      console.log(chalk.gray(`\n  ... and ${outdated.length - 10} more`));
    }
  }

  console.log(chalk.bold("\n💡 Commands:\n"));
  console.log(chalk.gray("  upshift upgrade --all-minor    Upgrade all workspaces (safe)"));
  console.log(chalk.gray("  upshift scan --workspace <name>  Scan specific workspace"));
  console.log("");
}

async function runWorkspacesScore(cwd: string): Promise<void> {
  const { detectMonorepo } = await import("../lib/monorepo.js");
  const { runScanForSuggest } = await import("../lib/scan.js");

  const monorepo = detectMonorepo(cwd);
  if (monorepo.type === "none") {
    console.log(chalk.yellow("Not a monorepo — use `upshift radar --score` for single projects."));
    return;
  }

  console.log(chalk.bold(`\n  Health Scores — ${monorepo.workspaces.length} workspaces\n`));

  let totalScore = 0;
  let scoredCount = 0;

  for (const ws of monorepo.workspaces) {
    const spinner = ora(`  Scoring ${ws.name}...`).start();
    try {
      const data = await runScanForSuggest(ws.path);
      if (!data) {
        spinner.warn(`  ${ws.name} — skipped (no package data)`);
        continue;
      }

      // Inline scoring (same logic as radar --score)
      let score = 100;
      const vulnCount = (data.vulnerabilities as any)?.totalCount ?? 0;
      const criticalCount = (data.vulnerabilities as any)?.criticalCount ?? 0;
      let majorOutdated = 0;
      for (const pkg of data.outdated) {
        const curMajor = parseInt(pkg.current.replace(/[^0-9]/, ""), 10);
        const latMajor = parseInt(pkg.latest.replace(/[^0-9]/, ""), 10);
        if (!isNaN(curMajor) && !isNaN(latMajor) && latMajor > curMajor) majorOutdated++;
      }
      score -= Math.min(40, criticalCount * 15);
      score -= Math.min(20, (vulnCount - criticalCount) * 5);
      score -= Math.min(20, majorOutdated * 4);
      score -= Math.min(10, Math.floor((data.outdated.length - majorOutdated) * 0.5));
      score = Math.max(0, Math.round(score));

      const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
      const colorFn = score >= 90 ? chalk.green : score >= 75 ? chalk.cyan : score >= 60 ? chalk.yellow : chalk.red;
      const bar = "█".repeat(Math.round(score / 10)) + "░".repeat(10 - Math.round(score / 10));

      spinner.stop();
      console.log(`  ${colorFn(`${grade} ${score}/100`)}  ${chalk.gray(`[${bar}]`)}  ${ws.name}`);
      if (data.outdated.length > 0 || vulnCount > 0) {
        console.log(
          chalk.gray(`          ${data.outdated.length} outdated · ${vulnCount} vulns · ${majorOutdated} major gaps`)
        );
      }

      totalScore += score;
      scoredCount++;
    } catch {
      spinner.warn(`  ${ws.name} — error`);
    }
  }

  if (scoredCount > 0) {
    const avg = Math.round(totalScore / scoredCount);
    const avgGrade = avg >= 90 ? "A" : avg >= 75 ? "B" : avg >= 60 ? "C" : avg >= 40 ? "D" : "F";
    const colorFn = avg >= 90 ? chalk.green : avg >= 75 ? chalk.cyan : avg >= 60 ? chalk.yellow : chalk.red;
    console.log("");
    console.log(`  ${chalk.bold("Fleet average:")} ${colorFn(`${avgGrade} ${avg}/100`)}`);
  }
  console.log("");
}
