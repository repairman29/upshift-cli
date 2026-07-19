import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { openUrl } from "../lib/open.js";
import { runScanForSuggest } from "../lib/scan.js";

const RADAR_URL = "https://upshiftai.dev/radar/";

export function radarCommand(): Command {
  return new Command("radar")
    .description("Dependency health dashboard — score, trend, and fleet overview")
    .option("--score", "Compute and display a local dependency health score (0-100)")
    .option("--no-open", "Print URL without opening browser (used with --score to skip browser)")
    .option("--cwd <path>", "Project directory to score", process.cwd())
    .option("--json", "Output score as JSON (implies --score, skips browser)")
    .action(async (options) => {
      const showScore = options.score || options.json;

      if (showScore) {
        await runRadarScore(options);
      } else {
        // Default: open browser dashboard
        if (options.open !== false) {
          try {
            await openUrl(RADAR_URL);
            process.stdout.write(`Opened ${RADAR_URL}\n`);
          } catch {
            process.stdout.write(`Radar: ${RADAR_URL}\n`);
          }
        } else {
          process.stdout.write(`${RADAR_URL}\n`);
        }
        process.stdout.write("\nOptions:\n");
        process.stdout.write("  upshift radar --score        Local health score (0-100)\n");
        process.stdout.write("  upshift radar --score --json JSON output for CI\n");
        process.stdout.write("\nPro: persistent dashboard with history at upshiftai.dev/radar\n");
        process.stdout.write("Upload: upshift scan --report report.json --upload\n");
      }
    });
}

interface HealthScore {
  score: number; // 0-100
  grade: "A" | "B" | "C" | "D" | "F";
  outdatedCount: number;
  vulnCount: number;
  criticalCount: number;
  majorOutdated: number; // packages with major version gap
  details: string[];
}

function computeHealthScore(
  outdated: Array<{ name: string; current: string; latest: string }>,
  vulns: { vulnerabilityCount: number; criticalCount: number } | null
): HealthScore {
  let score = 100;
  const details: string[] = [];

  const vulnCount = vulns?.vulnerabilityCount ?? 0;
  const criticalCount = vulns?.criticalCount ?? 0;
  const outdatedCount = outdated.length;

  // Count major version gaps (current major < latest major)
  let majorOutdated = 0;
  for (const pkg of outdated) {
    const curMajor = parseInt(pkg.current.replace(/[^0-9]/, ""), 10);
    const latMajor = parseInt(pkg.latest.replace(/[^0-9]/, ""), 10);
    if (!isNaN(curMajor) && !isNaN(latMajor) && latMajor > curMajor) {
      majorOutdated++;
    }
  }

  // Deductions
  if (criticalCount > 0) {
    const deduct = Math.min(40, criticalCount * 15);
    score -= deduct;
    details.push(`-${deduct} pts: ${criticalCount} critical vulnerability${criticalCount !== 1 ? "ies" : "y"}`);
  }
  if (vulnCount > criticalCount) {
    const nonCritical = vulnCount - criticalCount;
    const deduct = Math.min(20, nonCritical * 5);
    score -= deduct;
    details.push(`-${deduct} pts: ${nonCritical} non-critical vulnerability${nonCritical !== 1 ? "ies" : "y"}`);
  }
  if (majorOutdated > 0) {
    const deduct = Math.min(20, majorOutdated * 4);
    score -= deduct;
    details.push(`-${deduct} pts: ${majorOutdated} package${majorOutdated !== 1 ? "s" : ""} behind a major version`);
  }
  if (outdatedCount > majorOutdated) {
    const minorOutdated = outdatedCount - majorOutdated;
    const deduct = Math.min(10, Math.floor(minorOutdated * 0.5));
    if (deduct > 0) {
      score -= deduct;
      details.push(`-${deduct} pts: ${minorOutdated} package${minorOutdated !== 1 ? "s" : ""} on minor/patch updates`);
    }
  }

  score = Math.max(0, Math.round(score));

  const grade: HealthScore["grade"] =
    score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  return { score, grade, outdatedCount, vulnCount, criticalCount, majorOutdated, details };
}

function gradeColor(grade: string): (s: string) => string {
  if (grade === "A") return chalk.green;
  if (grade === "B") return chalk.cyan;
  if (grade === "C") return chalk.yellow;
  return chalk.red;
}

async function runRadarScore(options: { cwd: string; json?: boolean }) {
  const spinner = ora("Computing dependency health score...").start();

  try {
    const data = await runScanForSuggest(options.cwd);
    spinner.stop();

    if (!data) {
      console.error(chalk.red("Could not read dependencies. Make sure you're in a Node.js project."));
      process.exit(1);
    }

    const vulns = data.vulnerabilities
      ? {
          vulnerabilityCount: (data.vulnerabilities as any).totalCount ?? 0,
          criticalCount: (data.vulnerabilities as any).criticalCount ?? 0,
        }
      : null;

    const result = computeHealthScore(data.outdated, vulns);

    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    // Pretty output
    const colorFn = gradeColor(result.grade);
    const bar = "█".repeat(Math.round(result.score / 5)) + "░".repeat(20 - Math.round(result.score / 5));

    console.log("");
    console.log(chalk.bold("  Dependency Health Score"));
    console.log("");
    console.log(`  ${colorFn(`${result.score}/100`)}  Grade: ${colorFn(result.grade)}  ${chalk.gray(`[${bar}]`)}`);
    console.log("");
    if (result.details.length > 0) {
      console.log(chalk.gray("  Deductions:"));
      for (const d of result.details) {
        console.log(chalk.gray(`    ${d}`));
      }
      console.log("");
    } else {
      console.log(chalk.green("  No issues detected — all dependencies up to date!"));
      console.log("");
    }
    console.log(
      chalk.gray(
        `  Packages: ${result.outdatedCount} outdated (${result.majorOutdated} major gaps) · ${result.vulnCount} vulnerabilities (${result.criticalCount} critical)`
      )
    );
    console.log("");

    if (result.score < 75) {
      console.log(chalk.yellow("  Next steps:"));
      if (result.criticalCount > 0)
        console.log(chalk.yellow("    upshift audit --ai       # remediation plan for vulnerabilities"));
      if (result.majorOutdated > 0)
        console.log(chalk.yellow("    upshift migrate <pkg>    # guided major-version upgrade"));
      console.log(chalk.yellow("    upshift upgrade --all-minor  # safe minor/patch upgrades"));
      console.log("");
    }
    console.log(chalk.gray(`  Track history at: ${RADAR_URL}`));
    console.log("");

    // Exit with non-zero if grade is D or F (useful for CI)
    if (result.score < 40) process.exit(1);
  } catch (err) {
    spinner.fail("Score computation failed");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
