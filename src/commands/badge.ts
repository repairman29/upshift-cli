import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { runScanForSuggest } from "../lib/scan.js";

export function badgeCommand(): Command {
  return new Command("badge")
    .description("Generate a dependency health badge for your README")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--style <style>", "Badge style: flat | flat-square | for-the-badge", "flat")
    .option("--label <label>", "Badge label", "dependencies")
    .action(async (options) => {
      const spinner = ora("Computing health score...").start();

      try {
        const data = await runScanForSuggest(options.cwd);
        spinner.stop();

        if (!data) {
          console.error(chalk.red("Could not read dependencies."));
          process.exit(1);
        }

        const { score, grade, color } = computeBadgeScore(data.outdated, data.vulnerabilities);

        const label = encodeURIComponent(options.label);
        const message = encodeURIComponent(`${score}/100 ${grade}`);
        const shieldsUrl = `https://img.shields.io/badge/${label}-${message}-${color}?style=${options.style}`;

        const markdown = `![${options.label}](${shieldsUrl})`;
        const html = `<img src="${shieldsUrl}" alt="${options.label}" />`;

        console.log("");
        console.log(chalk.bold("  Dependency Health Badge"));
        console.log("");
        console.log(chalk.cyan("  Shields.io URL:"));
        console.log(`  ${shieldsUrl}`);
        console.log("");
        console.log(chalk.cyan("  Markdown (paste in README.md):"));
        console.log(`  ${markdown}`);
        console.log("");
        console.log(chalk.cyan("  HTML:"));
        console.log(`  ${html}`);
        console.log("");
        console.log(chalk.gray(`  Score: ${score}/100 · Grade: ${grade} · ${data.outdated.length} outdated`));
        console.log("");
        console.log(chalk.gray("  Tip: run this in CI and commit the badge URL to keep it current."));
        console.log(chalk.gray("  Example: upshift badge >> .upshift-badge && git commit -am 'chore: update badge'"));
        console.log("");
      } catch (err) {
        spinner.fail("Badge generation failed");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function computeBadgeScore(
  outdated: Array<{ current: string; latest: string }>,
  vulns: any
): { score: number; grade: string; color: string } {
  let score = 100;
  const vulnCount = vulns?.totalCount ?? vulns?.vulnerabilityCount ?? 0;
  const criticalCount = vulns?.criticalCount ?? 0;

  let majorOutdated = 0;
  for (const pkg of outdated) {
    const curMajor = parseInt(pkg.current.replace(/[^0-9]/, ""), 10);
    const latMajor = parseInt(pkg.latest.replace(/[^0-9]/, ""), 10);
    if (!isNaN(curMajor) && !isNaN(latMajor) && latMajor > curMajor) majorOutdated++;
  }

  score -= Math.min(40, criticalCount * 15);
  score -= Math.min(20, (vulnCount - criticalCount) * 5);
  score -= Math.min(20, majorOutdated * 4);
  score -= Math.min(10, Math.floor((outdated.length - majorOutdated) * 0.5));
  score = Math.max(0, Math.round(score));

  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  const color =
    score >= 90 ? "brightgreen" : score >= 75 ? "green" : score >= 60 ? "yellow" : score >= 40 ? "orange" : "red";

  return { score, grade, color };
}
