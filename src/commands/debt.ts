import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { runScanForSuggest } from "../lib/scan.js";

/** Rough effort in engineer-hours to upgrade one package */
const UPGRADE_EFFORT = {
  patch: 0.25, // 15 min
  minor: 1, // 1 hr
  major: 8, // 1 day
  majorWithCodemod: 3, // 3 hrs if codemod available
};

/** Packages that have official codemods / migration tooling */
const HAS_CODEMOD = new Set([
  "react",
  "react-dom",
  "next",
  "vue",
  "@angular/core",
  "typescript",
  "@babel/core",
  "jest",
  "webpack",
  "vite",
  "eslint",
  "prettier",
  "tailwindcss",
]);

interface DebtEntry {
  name: string;
  current: string;
  latest: string;
  bumpType: "patch" | "minor" | "major";
  hasCodemod: boolean;
  effortHours: number;
}

export function debtCommand(): Command {
  return new Command("debt")
    .description("Calculate upgrade debt: total engineering effort to reach latest")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--hourly-rate <rate>", "Engineer hourly rate in USD", "150")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const spinner = ora("Calculating upgrade debt...").start();

      try {
        const data = await runScanForSuggest(options.cwd);
        spinner.stop();

        if (!data || data.outdated.length === 0) {
          console.log(chalk.green("\n  ✔ No upgrade debt — all dependencies current.\n"));
          return;
        }

        const hourlyRate = parseFloat(options.hourlyRate) || 150;
        const entries: DebtEntry[] = [];

        for (const pkg of data.outdated) {
          const curMajor = parseInt(pkg.current.replace(/[^0-9]/, ""), 10);
          const latMajor = parseInt(pkg.latest.replace(/[^0-9]/, ""), 10);
          const curMinor = parseInt(pkg.current.split(".")[1] ?? "0", 10);
          const latMinor = parseInt(pkg.latest.split(".")[1] ?? "0", 10);

          let bumpType: DebtEntry["bumpType"];
          if (!isNaN(curMajor) && !isNaN(latMajor) && latMajor > curMajor) bumpType = "major";
          else if (!isNaN(curMinor) && !isNaN(latMinor) && latMinor > curMinor) bumpType = "minor";
          else bumpType = "patch";

          const hasCodemod = HAS_CODEMOD.has(pkg.name);
          const effort =
            bumpType === "major"
              ? hasCodemod
                ? UPGRADE_EFFORT.majorWithCodemod
                : UPGRADE_EFFORT.major
              : bumpType === "minor"
                ? UPGRADE_EFFORT.minor
                : UPGRADE_EFFORT.patch;

          entries.push({
            name: pkg.name,
            current: pkg.current,
            latest: pkg.latest,
            bumpType,
            hasCodemod,
            effortHours: effort,
          });
        }

        const totalHours = entries.reduce((s, e) => s + e.effortHours, 0);
        const totalCost = totalHours * hourlyRate;
        const majorEntries = entries.filter((e) => e.bumpType === "major");
        const minorEntries = entries.filter((e) => e.bumpType === "minor");
        const patchEntries = entries.filter((e) => e.bumpType === "patch");

        if (options.json) {
          process.stdout.write(
            JSON.stringify(
              {
                totalPackages: entries.length,
                totalHours,
                totalCostUsd: totalCost,
                hourlyRate,
                breakdown: { major: majorEntries.length, minor: minorEntries.length, patch: patchEntries.length },
                entries,
              },
              null,
              2
            ) + "\n"
          );
          return;
        }

        const fmtHours = (h: number) =>
          h < 1 ? `${Math.round(h * 60)}m` : h < 24 ? `${h.toFixed(1)}h` : `${(h / 8).toFixed(1)}d`;
        const fmtCost = (c: number) =>
          `$${c.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        const bar = (n: number, max: number, w = 16) => {
          const fill = max > 0 ? Math.round((n / max) * w) : 0;
          return "█".repeat(fill) + "░".repeat(w - fill);
        };

        const majorHours = majorEntries.reduce((s, e) => s + e.effortHours, 0);
        const minorHours = minorEntries.reduce((s, e) => s + e.effortHours, 0);
        const patchHours = patchEntries.reduce((s, e) => s + e.effortHours, 0);

        console.log("");
        console.log(chalk.bold("  Upgrade Debt Calculator"));
        console.log("");
        console.log(
          `  Total debt: ${chalk.red.bold(fmtHours(totalHours))}  (~${fmtCost(totalCost)} @ $${hourlyRate}/hr)`
        );
        console.log("");
        console.log(
          `  ${chalk.red(`Major  ${bar(majorEntries.length, entries.length)}`)}  ${majorEntries.length} pkg${majorEntries.length !== 1 ? "s" : ""}  ${fmtHours(majorHours)}`
        );
        console.log(
          `  ${chalk.yellow(`Minor  ${bar(minorEntries.length, entries.length)}`)}  ${minorEntries.length} pkg${minorEntries.length !== 1 ? "s" : ""}  ${fmtHours(minorHours)}`
        );
        console.log(
          `  ${chalk.gray(`Patch  ${bar(patchEntries.length, entries.length)}`)}  ${patchEntries.length} pkg${patchEntries.length !== 1 ? "s" : ""}  ${fmtHours(patchHours)}`
        );
        console.log("");

        if (majorEntries.length > 0) {
          console.log(chalk.bold("  High-effort major upgrades:"));
          const sorted = [...majorEntries].sort((a, b) => b.effortHours - a.effortHours);
          for (const e of sorted.slice(0, 6)) {
            const cm = e.hasCodemod ? chalk.cyan(" (codemod available)") : "";
            console.log(
              `    ${chalk.red(e.name.padEnd(28))} ${e.current} → ${e.latest}  ${fmtHours(e.effortHours)}${cm}`
            );
          }
          if (sorted.length > 6) console.log(chalk.gray(`    ... and ${sorted.length - 6} more`));
          console.log("");
        }

        console.log(chalk.gray("  Next steps:"));
        if (patchEntries.length > 0)
          console.log(chalk.gray(`    upshift upgrade --all-patch       # quick wins — ${fmtHours(patchHours)}`));
        if (majorEntries.some((e) => e.hasCodemod))
          console.log(chalk.gray(`    upshift migrate <pkg>             # guided major upgrade with codemod`));
        console.log(chalk.gray(`    upshift plan                       # dependency-ordered upgrade plan`));
        console.log("");
      } catch (err) {
        spinner.fail("Debt calculation failed");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
