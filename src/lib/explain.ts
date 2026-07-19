import chalk from "chalk";
import ora from "ora";
import { existsSync, readFileSync, readdirSync, Dirent } from "fs";
import path from "path";
import semver from "semver";
import { runCommand } from "./exec.js";
import { consumeCredit } from "./credits.js";
import { detectEcosystem } from "./ecosystem.js";

export type ExplainOptions = {
  cwd: string;
  packageName: string;
  fromVersion?: string;
  toVersion?: string;
  json?: boolean;
  risk?: boolean;
  changelog?: boolean;
  ai?: boolean;
};

export type RiskLevel = "low" | "medium" | "high";

export type RiskAssessment = {
  level: RiskLevel;
  majorDelta: number;
  hasVulnerabilities: boolean;
  weeklyDownloads: number;
  reasons: string[];
};

export async function runExplain(options: ExplainOptions): Promise<void> {
  const ecosystem = detectEcosystem(options.cwd);
  if (ecosystem === "python") {
    await runExplainPython(options);
    return;
  }
  if (ecosystem === "ruby") {
    await runExplainRuby(options);
    return;
  }
  if (ecosystem === "go") {
    await runExplainGo(options);
    return;
  }

  // Only consume credits for AI-powered explanations
  if (options.ai) {
    await consumeCredit("explain");
  }

  const spinner = ora(`Explaining ${options.packageName}...`).start();
  try {
    const currentVersion = options.fromVersion ?? getCurrentVersion(options.cwd, options.packageName);
    const targetVersion = options.toVersion ?? (await getLatestVersion(options.cwd, options.packageName));

    const majorDelta = getMajorDelta(currentVersion, targetVersion);
    const packageInfo = await getPackageInfo(options.cwd, options.packageName);

    // Risk assessment (always compute for JSON, or when --risk)
    let risk: RiskAssessment | undefined;
    if (options.risk || options.json) {
      risk = await assessRisk(options.cwd, options.packageName, currentVersion, targetVersion);
    }

    // Changelog (when --changelog)
    let changelog: string | null = null;
    if (options.changelog) {
      changelog = await fetchChangelog(options.packageName, packageInfo.repository);
    }

    // AI analysis (when --ai)
    let aiAnalysis: string | null = null;
    if (options.ai) {
      aiAnalysis = await getAIAnalysis(options.packageName, currentVersion, targetVersion, changelog);
    }

    spinner.succeed(options.ai ? "AI analysis ready" : "Explanation ready");

    const usageInCodebase = getUsageInCodebase(options.cwd, options.packageName);

    if (options.json) {
      const out = {
        package: options.packageName,
        currentVersion: currentVersion ?? null,
        targetVersion,
        majorDelta,
        breakingChanges: majorDelta > 0,
        risk: risk ?? null,
        usageInCodebase,
        homepage: packageInfo.homepage ?? null,
        repository: packageInfo.repository ?? null,
        bugs: packageInfo.bugs ?? null,
        changelog: changelog ?? null,
        aiAnalysis: aiAnalysis ?? null,
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      return;
    }

    // Risk-only mode: print one line and exit
    if (options.risk && risk) {
      const color = risk.level === "high" ? chalk.red : risk.level === "medium" ? chalk.yellow : chalk.green;
      process.stdout.write(
        `${options.packageName} ${currentVersion ?? "?"} → ${targetVersion}: ${color(risk.level.toUpperCase())}\n`
      );
      risk.reasons.forEach((r) => {
        process.stdout.write(`  - ${r}\n`);
      });
      return;
    }

    process.stdout.write(chalk.bold(`${options.packageName}\n`));
    process.stdout.write(`Current: ${currentVersion ?? "unknown"}\n`);
    process.stdout.write(`Target:  ${targetVersion}\n`);
    if (usageInCodebase.used) {
      process.stdout.write(chalk.green(`Used in your code: yes (${usageInCodebase.fileCount} file(s))\n`));
    } else {
      process.stdout.write(chalk.gray("Used in your code: not found (or only transitive)\n"));
    }

    if (majorDelta > 0) {
      process.stdout.write(chalk.yellow(`Potential breaking changes: major version increase (${majorDelta}).\n`));
    } else {
      process.stdout.write(chalk.green("No major version bump detected.\n"));
    }

    if (packageInfo.homepage) {
      process.stdout.write(`Homepage: ${packageInfo.homepage}\n`);
    }
    if (packageInfo.repository) {
      process.stdout.write(`Repository: ${packageInfo.repository}\n`);
    }
    if (packageInfo.bugs) {
      process.stdout.write(`Issues: ${packageInfo.bugs}\n`);
    }

    // Changelog output
    if (options.changelog && changelog) {
      process.stdout.write(chalk.bold("\nChangelog (recent releases):\n"));
      process.stdout.write(changelog + "\n");
    } else if (options.changelog && !changelog) {
      process.stdout.write(chalk.gray("\nNo changelog found.\n"));
    }

    // AI Analysis output
    if (options.ai && aiAnalysis) {
      process.stdout.write(chalk.bold.cyan("\n🤖 AI Analysis:\n"));
      process.stdout.write(aiAnalysis + "\n");
    }

    if (options.ai) {
      process.stdout.write(chalk.gray("\nTip: run `upshift upgrade <package>` to apply the upgrade.\n"));
    } else {
      process.stdout.write(
        chalk.gray("\nTip: run `upshift explain <package> --ai` for deep AI analysis (costs 1 credit).\n")
      );
    }
  } catch (error) {
    spinner.fail("Explain failed");
    throw error;
  }
}

function getUsageInCodebase(cwd: string, packageName: string): { used: boolean; fileCount: number } {
  const ext = [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"];
  const patterns = [
    new RegExp(`require\\s*\\(\\s*["']${escapeRe(packageName)}(?:/|["'])`, "m"),
    new RegExp(`from\\s+["']${escapeRe(packageName)}(?:/|["'])`, "m"),
    new RegExp(`import\\s+["']${escapeRe(packageName)}(?:/|["'])`, "m"),
  ];
  const subpath = packageName.replace(/^@[^/]+\//, "").split("/")[0];
  if (subpath !== packageName) {
    patterns.push(
      new RegExp(`require\\s*\\(\\s*["']${escapeRe(packageName)}`, "m"),
      new RegExp(`from\\s+["']${escapeRe(packageName)}`, "m")
    );
  }
  let fileCount = 0;
  function scan(dir: string): void {
    if (!existsSync(dir)) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        scan(full);
      } else if (ext.some((x) => e.name.endsWith(x))) {
        try {
          const content = readFileSync(full, "utf8");
          if (patterns.some((p) => p.test(content))) {
            fileCount++;
          }
        } catch {
          // skip
        }
      }
    }
  }
  scan(cwd);
  return { used: fileCount > 0, fileCount };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python: version delta, optional changelog/risk/AI, upgrade hint. */
async function runExplainPython(options: ExplainOptions): Promise<void> {
  const spinner = ora(`Explaining ${options.packageName} (Python)...`).start();
  try {
    if (options.ai) {
      await consumeCredit("explain");
    }

    let currentVersion = options.fromVersion ?? null;
    if (!currentVersion) {
      try {
        const result = await runCommand("pip", ["show", options.packageName], options.cwd, [0, 1]);
        const match = result.stdout.match(/^Version:\s*(.+)$/m);
        currentVersion = match ? match[1].trim() : null;
      } catch {
        const reqPath = path.join(options.cwd, "requirements.txt");
        const pyPath = path.join(options.cwd, "pyproject.toml");
        if (existsSync(reqPath)) {
          const raw = readFileSync(reqPath, "utf8");
          const re = new RegExp(`^${options.packageName}==([^\\s]+)`, "m");
          const m = raw.match(re);
          currentVersion = m ? m[1] : null;
        }
        if (!currentVersion && existsSync(pyPath)) {
          const raw = readFileSync(pyPath, "utf8");
          const re = new RegExp(`"${options.packageName}"\\s*[:=]\\s*"([^"]+)"`, "m");
          const m = raw.match(re);
          currentVersion = m ? m[1] : null;
        }
      }
    }

    let targetVersion = options.toVersion ?? null;
    let pypiInfo: { project_urls?: Record<string, string> } = {};
    try {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(options.packageName)}/json`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { info?: { version?: string; project_urls?: Record<string, string> } };
        pypiInfo = data.info ?? {};
        if (!targetVersion) targetVersion = data.info?.version ?? null;
      }
    } catch {
      // ignore
    }

    const majorDelta = targetVersion && currentVersion ? getMajorDelta(currentVersion, targetVersion) : 0;

    let changelog: string | null = null;
    if ((options.changelog || options.ai) && pypiInfo.project_urls) {
      const repoUrl =
        pypiInfo.project_urls["Source"] ?? pypiInfo.project_urls["Home"] ?? pypiInfo.project_urls["Homepage"];
      if (repoUrl?.includes("github.com")) changelog = await fetchChangelog(options.packageName, repoUrl);
    }

    let aiAnalysis: string | null = null;
    if (options.ai) {
      spinner.text = "Getting AI analysis...";
      aiAnalysis = await getAIAnalysisEcosystem(
        "python",
        options.packageName,
        currentVersion ?? undefined,
        targetVersion ?? "unknown",
        changelog
      );
    }

    spinner.succeed(options.ai ? "AI analysis ready" : "Explanation ready");

    if (options.json) {
      process.stdout.write(
        JSON.stringify({
          package: options.packageName,
          ecosystem: "python",
          currentVersion,
          targetVersion,
          majorDelta,
          breakingChanges: majorDelta > 0,
          changelog: options.changelog ? changelog : undefined,
          aiAnalysis: aiAnalysis ?? undefined,
          upgradeHint: "pip install -U " + options.packageName,
        }) + "\n"
      );
      return;
    }

    process.stdout.write(chalk.bold(`${options.packageName} (Python)\n`));
    process.stdout.write(`Current: ${currentVersion ?? "unknown"}\n`);
    process.stdout.write(`Target:  ${targetVersion ?? "unknown"}\n`);
    if (majorDelta > 0) {
      process.stdout.write(chalk.yellow(`Potential breaking changes: major version increase (${majorDelta}).\n`));
    }
    if (options.changelog && changelog) {
      process.stdout.write(chalk.bold("\nChangelog (recent releases):\n"));
      process.stdout.write(changelog + "\n");
    }
    if (options.ai && aiAnalysis) {
      process.stdout.write(chalk.bold.cyan("\n🤖 AI Analysis:\n"));
      process.stdout.write(aiAnalysis + "\n");
    }
    process.stdout.write(chalk.gray("\nUpgrade: pip install -U " + options.packageName + "\n"));
  } catch (err) {
    spinner.fail("Explain failed");
    throw err;
  }
}

/** Ruby: version delta, optional changelog/risk/AI, upgrade hint. */
async function runExplainRuby(options: ExplainOptions): Promise<void> {
  const spinner = ora(`Explaining ${options.packageName} (Ruby)...`).start();
  try {
    if (options.ai) {
      await consumeCredit("explain");
    }
    let currentVersion = options.fromVersion ?? null;
    if (!currentVersion) {
      try {
        const result = await runCommand("bundle", ["show", options.packageName], options.cwd, [0, 1]);
        const match = result.stdout.match(/^\s*\*?\s*[\w-]+\s+\(([^)]+)\)/m) || result.stdout.match(/[\d]+\.[\d.]+/);
        currentVersion = match ? (match[1] ?? match[0]).trim() : null;
      } catch {
        const gemfile = path.join(options.cwd, "Gemfile");
        if (existsSync(gemfile)) {
          const raw = readFileSync(gemfile, "utf8");
          const re = new RegExp(`gem\\s+["']${options.packageName}["']\\s*,\\s*["']([^"']+)["']`, "m");
          const m = raw.match(re);
          currentVersion = m ? m[1] : null;
        }
      }
    }

    let targetVersion = options.toVersion ?? null;
    let gemInfo: { version?: string; homepage?: string; source_code_uri?: string; project_uri?: string } = {};
    try {
      const res = await fetch(`https://rubygems.org/api/v1/gems/${encodeURIComponent(options.packageName)}.json`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json()) as {
          version?: string;
          homepage?: string;
          source_code_uri?: string;
          project_uri?: string;
        };
        gemInfo = data;
        targetVersion = targetVersion ?? data.version ?? null;
      }
    } catch {
      // ignore
    }

    const majorDelta = targetVersion && currentVersion ? getMajorDelta(currentVersion, targetVersion) : 0;

    let risk: RiskAssessment | undefined;
    if (options.risk || options.json) {
      risk = assessRiskRubyGo(currentVersion as string | undefined, targetVersion as string | undefined, majorDelta);
    }
    let changelog: string | null = null;
    if ((options.changelog || options.ai) && (gemInfo.source_code_uri || gemInfo.homepage)) {
      const repo = gemInfo.source_code_uri ?? gemInfo.homepage ?? undefined;
      if (repo?.includes("github.com")) changelog = await fetchChangelog(options.packageName, repo);
    }

    let aiAnalysis: string | null = null;
    if (options.ai) {
      spinner.text = "Getting AI analysis...";
      aiAnalysis = await getAIAnalysisEcosystem(
        "ruby",
        options.packageName,
        currentVersion ?? undefined,
        targetVersion ?? "unknown",
        changelog
      );
    }

    spinner.succeed(options.ai ? "AI analysis ready" : "Explanation ready");

    if (options.json) {
      process.stdout.write(
        JSON.stringify({
          package: options.packageName,
          ecosystem: "ruby",
          currentVersion,
          targetVersion,
          majorDelta,
          breakingChanges: majorDelta > 0,
          risk: risk ?? null,
          changelog,
          aiAnalysis: aiAnalysis ?? undefined,
          upgradeHint: "bundle update " + options.packageName,
        }) + "\n"
      );
      return;
    }

    if (options.risk && risk) {
      const color = risk.level === "high" ? chalk.red : risk.level === "medium" ? chalk.yellow : chalk.green;
      process.stdout.write(
        `${options.packageName} ${currentVersion ?? "?"} → ${targetVersion ?? "?"}: ${color(risk.level.toUpperCase())}\n`
      );
      risk.reasons.forEach((r) => {
        process.stdout.write(`  - ${r}\n`);
      });
      return;
    }

    process.stdout.write(chalk.bold(`${options.packageName} (Ruby)\n`));
    process.stdout.write(`Current: ${currentVersion ?? "unknown"}\n`);
    process.stdout.write(`Target:  ${targetVersion ?? "unknown"}\n`);
    if (majorDelta > 0) {
      process.stdout.write(chalk.yellow(`Potential breaking changes: major version increase (${majorDelta}).\n`));
    }
    if (options.changelog && changelog) {
      process.stdout.write(chalk.bold("\nChangelog (recent releases):\n"));
      process.stdout.write(changelog + "\n");
    } else if (options.changelog && !changelog) {
      process.stdout.write(chalk.gray("\nNo changelog found.\n"));
    }
    if (options.ai && aiAnalysis) {
      process.stdout.write(chalk.bold.cyan("\n🤖 AI Analysis:\n"));
      process.stdout.write(aiAnalysis + "\n");
    }
    process.stdout.write(chalk.gray("\nUpgrade: bundle update " + options.packageName + "\n"));
  } catch (err) {
    spinner.fail("Explain failed");
    throw err;
  }
}

/** Go: version delta, optional changelog/risk/AI, upgrade hint. */
async function runExplainGo(options: ExplainOptions): Promise<void> {
  const spinner = ora(`Explaining ${options.packageName} (Go)...`).start();
  try {
    if (options.ai) {
      await consumeCredit("explain");
    }
    let currentVersion = options.fromVersion ?? null;
    let targetVersion = options.toVersion ?? null;
    if (!currentVersion || !targetVersion) {
      try {
        const result = await runCommand("go", ["list", "-m", "-u", "-json", options.packageName], options.cwd, [0, 1]);
        const data = JSON.parse(result.stdout) as { Version?: string; Update?: { Version: string } };
        currentVersion = currentVersion ?? data.Version ?? null;
        targetVersion = targetVersion ?? data.Update?.Version ?? data.Version ?? null;
      } catch {
        try {
          const result = await runCommand("go", ["list", "-m", "-json", options.packageName], options.cwd, [0, 1]);
          const data = JSON.parse(result.stdout) as { Version?: string };
          currentVersion = currentVersion ?? data.Version ?? null;
        } catch {
          // ignore
        }
      }
    }

    const majorDelta = targetVersion && currentVersion ? getMajorDelta(currentVersion, targetVersion) : 0;

    let risk: RiskAssessment | undefined;
    if (options.risk || options.json) {
      risk = assessRiskRubyGo(currentVersion as string | undefined, targetVersion as string | undefined, majorDelta);
    }
    let changelog: string | null = null;
    if ((options.changelog || options.ai) && options.packageName.startsWith("github.com/")) {
      changelog = await fetchChangelog(options.packageName, "https://" + options.packageName);
    }

    let aiAnalysis: string | null = null;
    if (options.ai) {
      spinner.text = "Getting AI analysis...";
      aiAnalysis = await getAIAnalysisEcosystem(
        "go",
        options.packageName,
        currentVersion ?? undefined,
        targetVersion ?? "unknown",
        changelog
      );
    }

    spinner.succeed(options.ai ? "AI analysis ready" : "Explanation ready");

    if (options.json) {
      process.stdout.write(
        JSON.stringify({
          package: options.packageName,
          ecosystem: "go",
          currentVersion,
          targetVersion,
          majorDelta,
          breakingChanges: majorDelta > 0,
          risk: risk ?? null,
          changelog,
          aiAnalysis: aiAnalysis ?? undefined,
          upgradeHint: "go get " + options.packageName + "@latest",
        }) + "\n"
      );
      return;
    }

    if (options.risk && risk) {
      const color = risk.level === "high" ? chalk.red : risk.level === "medium" ? chalk.yellow : chalk.green;
      process.stdout.write(
        `${options.packageName} ${currentVersion ?? "?"} → ${targetVersion ?? "?"}: ${color(risk.level.toUpperCase())}\n`
      );
      risk.reasons.forEach((r) => {
        process.stdout.write(`  - ${r}\n`);
      });
      return;
    }

    process.stdout.write(chalk.bold(`${options.packageName} (Go)\n`));
    process.stdout.write(`Current: ${currentVersion ?? "unknown"}\n`);
    process.stdout.write(`Target:  ${targetVersion ?? "unknown"}\n`);
    if (majorDelta > 0) {
      process.stdout.write(chalk.yellow(`Potential breaking changes: major version increase (${majorDelta}).\n`));
    }
    if (options.changelog && changelog) {
      process.stdout.write(chalk.bold("\nChangelog (recent releases):\n"));
      process.stdout.write(changelog + "\n");
    } else if (options.changelog && !changelog) {
      process.stdout.write(chalk.gray("\nNo changelog found.\n"));
    }
    if (options.ai && aiAnalysis) {
      process.stdout.write(chalk.bold.cyan("\n🤖 AI Analysis:\n"));
      process.stdout.write(aiAnalysis + "\n");
    }
    process.stdout.write(chalk.gray("\nUpgrade: go get " + options.packageName + "@latest\n"));
  } catch (err) {
    spinner.fail("Explain failed");
    throw err;
  }
}

/** Simple risk for Ruby/Go (major delta only; no ecosystem vuln data). */
function assessRiskRubyGo(
  fromVersion: string | undefined,
  toVersion: string | undefined,
  majorDelta: number
): RiskAssessment {
  const reasons: string[] = [];
  let level: RiskLevel = "low";
  if (majorDelta >= 2) {
    level = "high";
    reasons.push(`Major version jump of ${majorDelta}`);
  } else if (majorDelta === 1) {
    level = "medium";
    reasons.push("Major version bump (potential breaking changes)");
  }
  if (reasons.length === 0) reasons.push("Minor or patch update; no ecosystem risk data");
  return { level, majorDelta, hasVulnerabilities: false, weeklyDownloads: 0, reasons };
}

function getCurrentVersion(cwd: string, packageName: string): string | undefined {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;

  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  return pkg.dependencies?.[packageName] ?? pkg.devDependencies?.[packageName] ?? pkg.peerDependencies?.[packageName];
}

async function getLatestVersion(cwd: string, packageName: string): Promise<string> {
  const result = await runCommand("npm", ["view", packageName, "version"], cwd);
  return result.stdout.trim();
}

function getMajorDelta(fromVersion: string | undefined, toVersion: string): number {
  if (!fromVersion) return 0;
  const cleanFrom = semver.coerce(fromVersion)?.version;
  const cleanTo = semver.coerce(toVersion)?.version;
  if (!cleanFrom || !cleanTo) return 0;
  const fromMajor = semver.major(cleanFrom);
  const toMajor = semver.major(cleanTo);
  return Math.max(0, toMajor - fromMajor);
}

async function getPackageInfo(
  cwd: string,
  packageName: string
): Promise<{ homepage?: string; repository?: string; bugs?: string }> {
  const result = await runCommand(
    "npm",
    ["view", packageName, "homepage", "repository.url", "bugs.url", "--json"],
    cwd,
    [0, 1]
  );
  if (!result.stdout.trim()) return {};
  const parsed = JSON.parse(result.stdout) as {
    homepage?: string;
    "repository.url"?: string;
    "bugs.url"?: string;
  };

  return {
    homepage: parsed.homepage,
    repository: parsed["repository.url"],
    bugs: parsed["bugs.url"],
  };
}

async function getWeeklyDownloads(packageName: string): Promise<number> {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`);
    if (!res.ok) return 0;
    const data = (await res.json()) as { downloads?: number };
    return data.downloads ?? 0;
  } catch {
    return 0;
  }
}

async function hasKnownVulnerabilities(cwd: string, packageName: string, _version: string): Promise<boolean> {
  try {
    const result = await runCommand("npm", ["audit", "--json", "--package-lock-only"], cwd, [0, 1]);
    if (!result.stdout.trim()) return false;
    const audit = JSON.parse(result.stdout) as {
      vulnerabilities?: Record<string, unknown>;
    };
    return Boolean(audit.vulnerabilities?.[packageName]);
  } catch {
    return false;
  }
}

export async function assessRisk(
  cwd: string,
  packageName: string,
  fromVersion: string | undefined,
  toVersion: string
): Promise<RiskAssessment> {
  const majorDelta = getMajorDelta(fromVersion, toVersion);
  const weeklyDownloads = await getWeeklyDownloads(packageName);
  const hasVulns = await hasKnownVulnerabilities(cwd, packageName, toVersion);

  const reasons: string[] = [];
  let level: RiskLevel = "low";

  if (majorDelta >= 2) {
    level = "high";
    reasons.push(`Major version jump of ${majorDelta}`);
  } else if (majorDelta === 1) {
    level = "medium";
    reasons.push("Major version bump (potential breaking changes)");
  }

  if (hasVulns) {
    level = "high";
    reasons.push("Known vulnerabilities in current version");
  }

  if (weeklyDownloads < 1000) {
    if (level === "low") level = "medium";
    reasons.push(`Low popularity (${weeklyDownloads.toLocaleString()} weekly downloads)`);
  } else if (weeklyDownloads > 1_000_000) {
    reasons.push(`High popularity (${weeklyDownloads.toLocaleString()} weekly downloads)`);
  }

  if (reasons.length === 0) {
    reasons.push("Minor or patch update, no known issues");
  }

  return { level, majorDelta, hasVulnerabilities: hasVulns, weeklyDownloads, reasons };
}

export async function fetchChangelog(packageName: string, repository?: string): Promise<string | null> {
  if (!repository) return null;

  // Extract GitHub owner/repo from repository URL
  const match = repository.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;

  const [, owner, repo] = match;

  // Try GitHub releases API first
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=5`, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (res.ok) {
      const releases = (await res.json()) as Array<{ tag_name: string; name: string; body: string }>;
      if (releases.length > 0) {
        const summary = releases
          .slice(0, 3)
          .map((r) => {
            const title = r.name || r.tag_name;
            const body = r.body?.slice(0, 300) ?? "";
            return `## ${title}\n${body}${body.length >= 300 ? "..." : ""}`;
          })
          .join("\n\n");
        return summary;
      }
    }
  } catch {
    // fall through
  }

  // Try raw CHANGELOG.md
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/CHANGELOG.md`);
    if (res.ok) {
      const text = await res.text();
      return text.slice(0, 2000) + (text.length > 2000 ? "\n..." : "");
    }
  } catch {
    // fall through
  }

  return null;
}

async function getAIAnalysis(
  packageName: string,
  fromVersion: string | undefined,
  toVersion: string,
  changelog: string | null
): Promise<string> {
  return getAIAnalysisEcosystem("node", packageName, fromVersion, toVersion, changelog);
}

/** AI analysis for any ecosystem (Python/Ruby/Go/Node). */
async function getAIAnalysisEcosystem(
  ecosystem: "node" | "python" | "ruby" | "go",
  packageName: string,
  fromVersion: string | undefined,
  toVersion: string,
  changelog: string | null
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey && baseURL.includes("openai.com")) {
    return (
      chalk.yellow("AI analysis unavailable (OPENAI_API_KEY not configured).\n") +
      "Set OPENAI_API_KEY environment variable to enable AI-powered explanations.\n" +
      "Or use a local model: set OPENAI_BASE_URL=http://127.0.0.1:1234/v1 and OPENAI_MODEL=qwen/qwen3-14b"
    );
  }

  const labels: Record<string, string> = {
    node: "npm package",
    python: "Python package",
    ruby: "Ruby gem",
    go: "Go module",
  };
  const upgradeCmds: Record<string, string> = {
    node: `npm install ${packageName}@${toVersion}`,
    python: `pip install -U ${packageName}`,
    ruby: `bundle update ${packageName}`,
    go: `go get ${packageName}@latest`,
  };
  const label = labels[ecosystem];
  const upgradeCmd = upgradeCmds[ecosystem];

  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: apiKey || "dummy", baseURL });

    const systemPrompt = `You are a senior software engineer helping developers upgrade ${label} dependencies safely.
Your task is to analyze a package upgrade and provide actionable guidance.
Be concise but thorough. Focus on:
1. Breaking changes that require code modifications
2. Deprecated APIs that need to be replaced
3. New features worth adopting
4. Common migration pitfalls
5. Specific code patterns to search for and update

Format your response with clear sections using markdown. Keep it under 500 words.`;

    const userPrompt = `Analyze upgrading **${packageName}** (${label}) from ${fromVersion ?? "unknown"} to ${toVersion}.

${changelog ? `Here's the recent changelog:\n\n${changelog.slice(0, 3000)}` : "No changelog available - provide general guidance for this package."}

Provide:
1. Summary of what changed
2. Breaking changes (if any)
3. Migration steps
4. Code patterns to search for in my codebase

Upgrade command: ${upgradeCmd}`;

    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return chalk.yellow("AI returned empty response. Try again.");
    }
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("401") || message.includes("invalid_api_key")) {
      return chalk.red("Invalid OpenAI API key. Check OPENAI_API_KEY.");
    }
    if (message.includes("429") || message.includes("rate_limit")) {
      return chalk.yellow("OpenAI rate limit hit. Try again in a moment.");
    }
    if (message.includes("insufficient_quota")) {
      return chalk.red("OpenAI quota exceeded. Add billing at platform.openai.com");
    }
    return chalk.yellow(`AI analysis failed: ${message}`);
  }
}
