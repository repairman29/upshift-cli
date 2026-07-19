/**
 * Multi-step upgrade plan: ordered list of upgrades (dependency order, compatibility).
 */

import chalk from "chalk";
import { runScanForSuggest } from "./scan.js";
import { getUpgradeType } from "./version-bump-kind.js";
import { assessRisk } from "./explain.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

export type PlanOptions = {
  cwd: string;
  json: boolean;
  mode?: "all" | "minor" | "patch";
};

export type PlanStep = {
  order: number;
  name: string;
  current: string;
  target: string;
  upgradeType: "major" | "minor" | "patch";
  risk: "low" | "medium" | "high";
  reason: string;
};

/** Get direct dependency order from package.json (dependencies first, then devDependencies). */
function getDeclaredOrder(cwd: string): string[] {
  const pkgPath = path.join(cwd, "package.json");
  if (!existsSync(pkgPath)) return [];
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const order = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  return order;
}

export async function runPlan(options: PlanOptions): Promise<void> {
  const mode = options.mode ?? "all";
  const data = await runScanForSuggest(options.cwd);
  if (!data || data.outdated.length === 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ steps: [], message: "No outdated packages" }, null, 2) + "\n");
    } else {
      process.stdout.write(chalk.green("No outdated dependencies. Nothing to plan.\n"));
    }
    return;
  }

  const declaredOrder = getDeclaredOrder(options.cwd);
  const steps: PlanStep[] = [];
  let order = 0;

  for (const entry of data.outdated) {
    const upgradeType = getUpgradeType(entry.current, entry.latest);
    if (mode === "minor" && upgradeType === "major") continue;
    if (mode === "patch" && upgradeType !== "patch") continue;

    const risk = await assessRisk(options.cwd, entry.name, entry.current, entry.latest);
    const reason =
      risk.level === "high"
        ? "Major or high risk—upgrade first and run tests"
        : risk.level === "medium"
          ? "Review changelog before upgrading"
          : "Safe to upgrade";

    const declaredIndex = declaredOrder.indexOf(entry.name);
    steps.push({
      order: declaredIndex >= 0 ? declaredIndex : 1000 + order,
      name: entry.name,
      current: entry.current,
      target: entry.latest,
      upgradeType,
      risk: risk.level,
      reason,
    });
    order++;
  }

  // Sort: declared order first, then by risk (high first), then major before minor/patch
  steps.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    const riskOrder = { high: 0, medium: 1, low: 2 };
    if (riskOrder[a.risk] !== riskOrder[b.risk]) return riskOrder[a.risk] - riskOrder[b.risk];
    const typeOrder = { major: 0, minor: 1, patch: 2 };
    return typeOrder[a.upgradeType] - typeOrder[b.upgradeType];
  });

  const numbered = steps.map((s, i) => ({ ...s, order: i + 1 }));

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          packageManager: data.packageManager,
          mode,
          steps: numbered.map(({ order, name, current, target, upgradeType, risk, reason }) => ({
            order,
            name,
            current,
            target,
            upgradeType,
            risk,
            reason,
          })),
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  process.stdout.write(chalk.bold("Upgrade plan (recommended order):\n\n"));
  for (const s of numbered) {
    const riskColor = s.risk === "low" ? chalk.green : s.risk === "medium" ? chalk.yellow : chalk.red;
    process.stdout.write(
      `  ${s.order}. ${chalk.cyan(s.name)} ${s.current} → ${s.target} ${riskColor(`(${s.risk}, ${s.upgradeType})`)} — ${s.reason}\n`
    );
  }
  process.stdout.write(
    chalk.gray("\nRun `upshift upgrade <package>` for each, or `upshift upgrade --all` to batch.\n")
  );
}
