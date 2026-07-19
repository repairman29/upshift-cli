/**
 * Proactive upgrade suggestions: low risk, high value.
 * Opt-in, privacy-preserving; no telemetry by default.
 */

import chalk from "chalk";
import { runScanForSuggest } from "./scan.js";
import { assessRisk } from "./explain.js";
import semver from "semver";

interface ConfidenceData {
  confidence: number | null;
  grade: "high" | "medium" | "low" | null;
  totalSignals: number;
}

async function fetchConfidence(
  packageName: string,
  fromVersion: string,
  toVersion: string
): Promise<ConfidenceData | null> {
  const apiBase = process.env.UPSHIFT_API_URL || "https://upshiftai.dev";
  try {
    const url = `${apiBase}/api/confidence?package=${encodeURIComponent(packageName)}&from=${encodeURIComponent(fromVersion)}&to=${encodeURIComponent(toVersion)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.json()) as ConfidenceData;
  } catch {
    return null;
  }
}

export type SuggestOptions = {
  cwd: string;
  json: boolean;
  limit?: number;
};

export type Suggestion = {
  name: string;
  current: string;
  latest: string;
  upgradeType: "major" | "minor" | "patch";
  risk: "low" | "medium" | "high";
  reason: string;
};

export async function runSuggest(options: SuggestOptions): Promise<void> {
  const limit = options.limit ?? 5;

  const scanResult = await runScanForSuggest(options.cwd);
  if (!scanResult || scanResult.outdated.length === 0) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ suggestions: [], message: "No outdated packages" }, null, 2) + "\n");
    } else {
      process.stdout.write(chalk.green("No outdated dependencies. You're up to date.\n"));
    }
    return;
  }

  const suggestions: Suggestion[] = [];
  for (const entry of scanResult.outdated.slice(0, 15)) {
    const risk = await assessRisk(options.cwd, entry.name, entry.current, entry.latest);
    const currentClean = semver.coerce(entry.current)?.version;
    const latestClean = semver.coerce(entry.latest)?.version;
    const upgradeType =
      !currentClean || !latestClean
        ? "major"
        : semver.major(latestClean) > semver.major(currentClean)
          ? "major"
          : semver.minor(latestClean) > semver.minor(currentClean)
            ? "minor"
            : "patch";

    let reason = "";
    if (risk.level === "low" && (upgradeType === "patch" || upgradeType === "minor")) {
      reason = "Low risk, safe to upgrade";
    } else if (risk.level === "medium" && upgradeType === "minor") {
      reason = "Minor bump, moderate risk—review changelog";
    } else if (risk.level === "high") {
      reason = risk.reasons[0] ?? "Higher risk—run `upshift explain " + entry.name + " --ai`";
    } else {
      reason = risk.reasons[0] ?? "Review before upgrading";
    }

    suggestions.push({
      name: entry.name,
      current: entry.current,
      latest: entry.latest,
      upgradeType,
      risk: risk.level,
      reason,
    });
  }

  // Sort: prefer low risk + minor/patch, then by name
  suggestions.sort((a, b) => {
    const score = (s: Suggestion) =>
      (s.risk === "low" ? 3 : s.risk === "medium" ? 2 : 0) +
      (s.upgradeType === "patch" ? 2 : s.upgradeType === "minor" ? 1 : 0);
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });

  if (options.json) {
    const top = suggestions.slice(0, limit);
    process.stdout.write(
      JSON.stringify({ packageManager: scanResult.packageManager, suggestions: top }, null, 2) + "\n"
    );
    return;
  }

  // Enrich top suggestions with community confidence data (non-blocking, 3s timeout)
  const enriched = await Promise.all(
    suggestions.slice(0, limit).map(async (s) => {
      const conf = await fetchConfidence(s.name, s.current, s.latest);
      return { ...s, confidence: conf };
    })
  );

  process.stdout.write(chalk.bold("Recommended upgrades (low risk, high value):\n\n"));
  for (const s of enriched) {
    const riskColor = s.risk === "low" ? chalk.green : s.risk === "medium" ? chalk.yellow : chalk.red;
    process.stdout.write(
      `  ${chalk.cyan(s.name)} ${s.current} → ${s.latest} ${riskColor(`(${s.risk})`)} — ${s.reason}\n`
    );
    if (s.confidence?.confidence !== null && s.confidence?.confidence !== undefined) {
      const gradeLabel = s.confidence.grade ? ` ← ${s.confidence.grade}` : "";
      process.stdout.write(
        chalk.gray(
          `  Community confidence: ${s.confidence.confidence}% (${s.confidence.totalSignals} upgrades)${gradeLabel}\n`
        )
      );
    }
  }
  process.stdout.write(
    chalk.gray("\nRun `upshift explain <package> --ai` for details, or `upshift upgrade <package>` to apply.\n")
  );
}
