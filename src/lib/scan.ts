import chalk from "chalk";
import ora from "ora";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import {
  detectEcosystem,
  getPythonOutdated,
  getRubyOutdated,
  getGoOutdated,
  getCargoOutdated,
  getCargoAudit,
  detectPythonDiamondConflicts,
} from "./ecosystem.js";

export type ScanOptions = {
  cwd: string;
  json: boolean;
  licenses?: boolean;
  report?: string;
  /** When set with report, POST report to Radar Pro (env UPSHIFT_RADAR_UPLOAD_URL + UPSHIFT_RADAR_TOKEN) */
  uploadUrl?: string;
  uploadToken?: string;
};

export type OutdatedEntry = {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type?: string;
};

async function uploadReport(uploadUrl: string, token: string, report: Record<string, unknown>): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Token": token,
    },
    body: JSON.stringify({ report }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Radar Pro upload failed (${res.status}): ${err}`);
  }
}

/** Returns raw scan data for use by suggest/plan/Radar. Node only. */
export async function runScanForSuggest(cwd: string): Promise<{
  packageManager: string;
  outdated: OutdatedEntry[];
  vulnerabilities: VulnerabilitySummary | null;
} | null> {
  try {
    const packageManager = detectPackageManager(cwd);
    const outdated = await getOutdatedDependencies(packageManager, cwd);
    const vulnerabilities = await getVulnerabilities(packageManager, cwd);
    return { packageManager, outdated, vulnerabilities };
  } catch {
    return null;
  }
}

export async function runScan(options: ScanOptions): Promise<void> {
  const spinner = ora("Scanning dependencies...").start();
  try {
    const ecosystem = detectEcosystem(options.cwd);

    if (ecosystem !== "node") {
      let outdated: OutdatedEntry[];
      let label: string;
      let licenses: Record<string, string> | undefined;
      let cargoAudit: Awaited<ReturnType<typeof getCargoAudit>> | undefined;
      let diamonds: Awaited<ReturnType<typeof detectPythonDiamondConflicts>> | undefined;

      if (ecosystem === "python") {
        outdated = await getPythonOutdated(options.cwd);
        label = "python (pip/poetry/pypi)";
        if (options.licenses) licenses = await getPythonLicenses(options.cwd);
        // Always check for diamond conflicts on Python projects
        diamonds = await detectPythonDiamondConflicts(options.cwd);
      } else if (ecosystem === "ruby") {
        outdated = await getRubyOutdated(options.cwd);
        label = "ruby (bundler)";
      } else if (ecosystem === "rust") {
        [outdated, cargoAudit] = await Promise.all([getCargoOutdated(options.cwd), getCargoAudit(options.cwd)]);
        label = "rust (cargo)";
      } else {
        outdated = await getGoOutdated(options.cwd);
        label = "go";
      }
      spinner.succeed("Scan complete");
      const reportPayload = options.report
        ? {
            status: "ok",
            ecosystem: label,
            outdated,
            licenses: licenses ?? undefined,
            diamondConflicts: diamonds?.length ? diamonds : undefined,
            cargoAudit: cargoAudit ?? undefined,
            cwd: options.cwd,
            timestamp: new Date().toISOString(),
          }
        : undefined;
      if (reportPayload && options.report) {
        const { writeFileSync } = await import("fs");
        writeFileSync(options.report, JSON.stringify(reportPayload, null, 2), "utf8");
      }
      if (options.uploadUrl && options.uploadToken && reportPayload) {
        await uploadReport(options.uploadUrl, options.uploadToken, reportPayload);
      }
      if (options.json) {
        const out: Record<string, unknown> = { status: "ok", ecosystem: label, outdated };
        if (licenses) out.licenses = licenses;
        if (diamonds?.length) out.diamondConflicts = diamonds;
        if (cargoAudit) out.cargoAudit = cargoAudit;
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return;
      }
      renderHumanOutput(label, outdated, null, licenses);
      if (diamonds?.length) renderDiamondConflicts(diamonds);
      if (cargoAudit?.vulnerabilities.length) renderCargoAudit(cargoAudit);
      return;
    }

    const packageManager = detectPackageManager(options.cwd);
    const outdated = await getOutdatedDependencies(packageManager, options.cwd);
    const vulnerabilities = await getVulnerabilities(packageManager, options.cwd);

    let licenses: Record<string, string> | undefined;
    if (options.licenses && packageManager === "npm") {
      licenses = await getLicenses(options.cwd);
    }

    const reportPayload = options.report
      ? {
          status: "ok",
          packageManager,
          outdated,
          vulnerabilities,
          licenses: licenses ?? undefined,
          cwd: options.cwd,
          timestamp: new Date().toISOString(),
        }
      : undefined;
    if (reportPayload && options.report) {
      const { writeFileSync } = await import("fs");
      writeFileSync(options.report, JSON.stringify(reportPayload, null, 2), "utf8");
    }
    if (options.uploadUrl && options.uploadToken && reportPayload) {
      await uploadReport(options.uploadUrl, options.uploadToken, reportPayload);
      const { emitAuditEvent } = await import("./audit-log.js");
      await emitAuditEvent("scan_upload", "report", undefined, {
        outdated_count: reportPayload.outdated?.length ?? 0,
        cwd: options.cwd,
      });
    }

    spinner.succeed("Scan complete");

    if (options.json) {
      const out: Record<string, unknown> = {
        status: "ok",
        packageManager,
        outdated,
        vulnerabilities,
      };
      if (licenses) out.licenses = licenses;
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }

    renderHumanOutput(packageManager, outdated, vulnerabilities, licenses);
  } catch (error) {
    spinner.fail("Scan failed");
    throw error;
  }
}

export type VulnerabilitySummary = {
  counts: Record<string, number>;
  items: Array<{
    name: string;
    severity: string;
    range?: string;
    fixAvailable?: boolean | { name: string; version: string; isSemVerMajor?: boolean };
    via?: Array<string | { name: string; title?: string }>;
  }>;
};

async function getLicenses(cwd: string): Promise<Record<string, string>> {
  const { readFileSync, existsSync } = await import("fs");
  const path = await import("path");
  const pkgPath = path.join(cwd, "package.json");
  if (!existsSync(pkgPath)) return {};
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const licenses: Record<string, string> = {};
  for (const name of Object.keys(deps)) {
    try {
      const result = await runCommand("npm", ["view", name, "license", "--json"], cwd, [0, 1]);
      const trimmed = result.stdout.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          licenses[name] = typeof parsed === "string" ? parsed : (parsed?.license ?? "unknown");
        } catch {
          licenses[name] = trimmed;
        }
      }
    } catch {
      licenses[name] = "unknown";
    }
  }
  return licenses;
}

/** Python: fetch license per direct dep from PyPI. */
async function getPythonLicenses(cwd: string): Promise<Record<string, string>> {
  const reqPath = path.join(cwd, "requirements.txt");
  const pyPath = path.join(cwd, "pyproject.toml");
  const names: string[] = [];
  if (existsSync(reqPath)) {
    const raw = readFileSync(reqPath, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([a-zA-Z0-9_-]+)/);
      if (m && !line.startsWith("#")) names.push(m[1]);
    }
  }
  if (existsSync(pyPath)) {
    const raw = readFileSync(pyPath, "utf8");
    const depMatch = raw.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depMatch) {
      for (const part of depMatch[1].split(/["']([a-zA-Z0-9_-]+)["']/)) {
        if (part && /^[a-zA-Z0-9_-]+$/.test(part)) names.push(part);
      }
    }
  }
  const seen = new Set<string>();
  const licenses: Record<string, string> = {};
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        licenses[name] = "unknown";
        continue;
      }
      const data = (await res.json()) as { info?: { license?: string; classifiers?: string[] } };
      const info = data.info;
      let licenseStr = info?.license?.trim();
      if (!licenseStr && info?.classifiers?.length) {
        const licenseClassifier = info.classifiers.find((c) => c.startsWith("License ::"));
        if (licenseClassifier) licenseStr = licenseClassifier.replace(/^License :: /, "");
      }
      licenses[name] = licenseStr || "unknown";
    } catch {
      licenses[name] = "unknown";
    }
  }
  return licenses;
}

function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
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

async function getOutdatedDependencies(packageManager: "npm" | "yarn" | "pnpm", cwd: string): Promise<OutdatedEntry[]> {
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
    // yarn outdated --json outputs NDJSON with type: "table"
    const result = await runCommand("yarn", ["outdated", "--json"], cwd, [0, 1]);
    const stdout = result.stdout.trim();
    if (!stdout) return [];

    const entries: OutdatedEntry[] = [];
    for (const line of stdout.split("\n")) {
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          data?: { body?: Array<[string, string, string, string, string, string]> };
        };
        if (obj.type === "table" && obj.data?.body) {
          for (const row of obj.data.body) {
            // [name, current, wanted, latest, type, url]
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
    // pnpm outdated --json returns array
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

async function getVulnerabilities(
  packageManager: "npm" | "yarn" | "pnpm",
  cwd: string
): Promise<VulnerabilitySummary | null> {
  if (packageManager === "npm") {
    const result = await runCommand("npm", ["audit", "--json"], cwd, [0, 1, 2]);
    const stdout = result.stdout.trim();
    if (!stdout) return null;

    const parsed = JSON.parse(stdout) as {
      metadata?: { vulnerabilities?: Record<string, number> };
      vulnerabilities?: Record<
        string,
        {
          name: string;
          severity: string;
          range?: string;
          fixAvailable?: boolean | { name: string; version: string; isSemVerMajor?: boolean };
          via?: Array<string | { name: string; title?: string }>;
        }
      >;
    };

    const counts = parsed.metadata?.vulnerabilities ?? {};
    const items = Object.values(parsed.vulnerabilities ?? {}).map((item) => ({
      name: item.name,
      severity: item.severity,
      range: item.range,
      fixAvailable: item.fixAvailable,
      via: item.via,
    }));

    return { counts, items };
  }

  if (packageManager === "yarn") {
    // yarn audit --json outputs NDJSON with advisories
    const result = await runCommand("yarn", ["audit", "--json"], cwd, [0, 1, 2, 4, 8, 16]);
    const stdout = result.stdout.trim();
    if (!stdout) return null;

    const counts: Record<string, number> = {};
    const items: VulnerabilitySummary["items"] = [];

    for (const line of stdout.split("\n")) {
      try {
        const obj = JSON.parse(line) as {
          type?: string;
          data?: {
            advisory?: {
              module_name?: string;
              severity?: string;
              vulnerable_versions?: string;
              title?: string;
            };
            vulnerabilities?: { info?: number; low?: number; moderate?: number; high?: number; critical?: number };
          };
        };
        if (obj.type === "auditAdvisory" && obj.data?.advisory) {
          const adv = obj.data.advisory;
          items.push({
            name: adv.module_name ?? "unknown",
            severity: adv.severity ?? "unknown",
            range: adv.vulnerable_versions,
            via: adv.title ? [adv.title] : undefined,
          });
        }
        if (obj.type === "auditSummary" && obj.data?.vulnerabilities) {
          const v = obj.data.vulnerabilities;
          if (v.info) counts["info"] = v.info;
          if (v.low) counts["low"] = v.low;
          if (v.moderate) counts["moderate"] = v.moderate;
          if (v.high) counts["high"] = v.high;
          if (v.critical) counts["critical"] = v.critical;
        }
      } catch {
        // skip malformed lines
      }
    }

    return { counts, items };
  }

  if (packageManager === "pnpm") {
    // pnpm audit --json
    const result = await runCommand("pnpm", ["audit", "--json"], cwd, [0, 1, 2]);
    const stdout = result.stdout.trim();
    if (!stdout) return null;

    try {
      const parsed = JSON.parse(stdout) as {
        metadata?: { vulnerabilities?: Record<string, number> };
        advisories?: Record<
          string,
          {
            module_name?: string;
            severity?: string;
            vulnerable_versions?: string;
            title?: string;
          }
        >;
      };

      const counts = parsed.metadata?.vulnerabilities ?? {};
      const items = Object.values(parsed.advisories ?? {}).map((adv) => ({
        name: adv.module_name ?? "unknown",
        severity: adv.severity ?? "unknown",
        range: adv.vulnerable_versions,
        via: adv.title ? [adv.title] : undefined,
      }));

      return { counts, items };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Aggregate vulnerability counts for notifications (npm, yarn, pnpm audit).
 */
export async function getVulnerabilitySummaryForDirectory(
  cwd: string,
  pm: "npm" | "yarn" | "pnpm"
): Promise<{ vulnerabilityCount: number; criticalCount: number }> {
  try {
    const summary = await getVulnerabilities(pm, cwd);
    if (!summary) {
      return { vulnerabilityCount: 0, criticalCount: 0 };
    }
    const c = summary.counts;
    const critical = typeof c.critical === "number" ? c.critical : 0;
    let total = 0;
    for (const n of Object.values(c)) {
      if (typeof n === "number") total += n;
    }
    if (total === 0 && summary.items.length > 0) {
      return {
        vulnerabilityCount: summary.items.length,
        criticalCount: summary.items.filter((i) => i.severity === "critical").length,
      };
    }
    return { vulnerabilityCount: total, criticalCount: critical };
  } catch {
    return { vulnerabilityCount: 0, criticalCount: 0 };
  }
}

function renderHumanOutput(
  packageManager: string,
  outdated: OutdatedEntry[],
  vulnerabilities: VulnerabilitySummary | null,
  licenses?: Record<string, string>
): void {
  process.stdout.write(chalk.bold(`Package manager: ${packageManager}\n`));
  process.stdout.write("\n");
  if (outdated.length === 0) {
    process.stdout.write(chalk.green("No outdated dependencies found.\n"));
  } else {
    process.stdout.write(chalk.yellow("Outdated dependencies:\n"));
    for (const entry of outdated) {
      process.stdout.write(`- ${entry.name}: ${entry.current} -> ${entry.wanted} (latest ${entry.latest})\n`);
    }
  }

  if (licenses && Object.keys(licenses).length > 0) {
    process.stdout.write(chalk.bold("\nLicenses (direct deps):\n"));
    for (const [name, license] of Object.entries(licenses)) {
      process.stdout.write(`- ${name}: ${license}\n`);
    }
  }

  process.stdout.write("\n");
  if (!vulnerabilities) {
    process.stdout.write(chalk.gray("No vulnerability data available.\n"));
    return;
  }

  const countLines = Object.entries(vulnerabilities.counts).map(([severity, count]) => `${severity}: ${count}`);
  process.stdout.write(chalk.red(`Vulnerabilities: ${countLines.join(", ") || "none"}\n`));
  if (vulnerabilities.items.length === 0) {
    process.stdout.write(chalk.green("No vulnerability details found.\n"));
    return;
  }

  for (const item of vulnerabilities.items) {
    process.stdout.write(`- ${item.name} (${item.severity})\n`);
  }
}

/** Render diamond dependency conflict warnings. */
function renderDiamondConflicts(
  conflicts: Array<{
    package: string;
    pinnedAt: string;
    latestAvailable: string;
    blockedBy: string[];
    explanation: string;
  }>
): void {
  process.stdout.write(chalk.bold.yellow("\n⬡ Diamond Dependency Conflicts:\n"));
  for (const c of conflicts) {
    process.stdout.write(
      `  ${chalk.yellow("⚠")} ${chalk.bold(c.package)} pinned at ${c.pinnedAt} (latest: ${c.latestAvailable})\n`
    );
    if (c.blockedBy.length > 0) {
      process.stdout.write(`    Blocked by: ${c.blockedBy.join(", ")}\n`);
    }
    process.stdout.write(`    ${chalk.gray(c.explanation)}\n`);
  }
  process.stdout.write("\n");
}

/** Render Rust/Cargo security advisories. */
function renderCargoAudit(audit: {
  vulnerabilities: Array<{
    id: string;
    package: string;
    version: string;
    title: string;
    severity?: string;
    url?: string;
  }>;
  warnings: Array<{ id: string; package: string; kind: string; title: string }>;
}): void {
  if (audit.vulnerabilities.length === 0 && audit.warnings.length === 0) return;
  process.stdout.write(chalk.bold.red("\n🦀 Cargo Audit (RustSec):\n"));
  for (const v of audit.vulnerabilities) {
    const sev = v.severity ?? "unknown";
    const sevColor = sev === "critical" ? chalk.bgRed : sev === "high" ? chalk.red : chalk.yellow;
    process.stdout.write(`  ${sevColor(sev.toUpperCase())} ${chalk.bold(v.package)} ${v.version} — ${v.title}\n`);
    if (v.url) process.stdout.write(`    ${chalk.gray(v.url)}\n`);
  }
  for (const w of audit.warnings) {
    process.stdout.write(`  ${chalk.yellow("WARN")} ${chalk.bold(w.package)} — ${w.title} (${w.kind})\n`);
  }
  process.stdout.write("\n");
}
