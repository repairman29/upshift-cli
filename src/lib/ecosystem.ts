/**
 * Ecosystem detection: node (npm/yarn/pnpm), python (pip/poetry/pyproject), ruby (bundler), go, rust (cargo).
 */

import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";

export type Ecosystem = "node" | "python" | "ruby" | "go" | "rust";

export function detectEcosystem(cwd: string): Ecosystem {
  const pkgJson = path.join(cwd, "package.json");
  const pyProject = path.join(cwd, "pyproject.toml");
  const requirementsTxt = path.join(cwd, "requirements.txt");
  const gemfile = path.join(cwd, "Gemfile");
  const goMod = path.join(cwd, "go.mod");
  const cargoToml = path.join(cwd, "Cargo.toml");

  if (
    existsSync(pkgJson) ||
    existsSync(path.join(cwd, "package-lock.json")) ||
    existsSync(path.join(cwd, "yarn.lock")) ||
    existsSync(path.join(cwd, "pnpm-lock.yaml"))
  ) {
    return "node";
  }
  if (existsSync(pyProject) || existsSync(requirementsTxt)) {
    return "python";
  }
  if (existsSync(gemfile)) {
    return "ruby";
  }
  if (existsSync(goMod)) {
    return "go";
  }
  if (existsSync(cargoToml)) {
    return "rust";
  }

  // No recognized project files - return node as default but log a warning
  console.warn(
    chalk.yellow(
      "Warning: No recognized project files found (package.json, pyproject.toml, requirements.txt, Gemfile, go.mod, Cargo.toml). Assuming Node.js project."
    )
  );
  return "node"; // default
}

export type OutdatedEntry = {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type?: string;
};

export type DiamondConflict = {
  /** The package that is blocked from upgrading */
  package: string;
  /** The version it's pinned to */
  pinnedAt: string;
  /** The latest available version */
  latestAvailable: string;
  /** The package(s) causing the constraint */
  blockedBy: string[];
  /** Human-readable explanation */
  explanation: string;
};

// ---------------------------------------------------------------------------
// Python scanning
// ---------------------------------------------------------------------------

/** Parse pyproject.toml and extract dependency names + version specifiers. */
function parsePyprojectDeps(content: string): Array<{ name: string; specifier: string }> {
  const deps: Array<{ name: string; specifier: string }> = [];

  // PEP 621 style: [project] ... dependencies = ["numpy>=1.0,<2", ...]
  const pep621Match = content.match(/\[project\][\s\S]*?^dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (pep621Match) {
    const depList = pep621Match[1];
    for (const match of depList.matchAll(/["']([a-zA-Z0-9_.-]+)([^"']*?)["']/g)) {
      const name = match[1].replace(/_/g, "-").toLowerCase();
      if (name !== "python") deps.push({ name, specifier: match[2] });
    }
  }

  // Poetry style: [tool.poetry.dependencies] numpy = "^1.0"
  if (deps.length === 0) {
    const poetrySection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=^\[)/m);
    if (poetrySection) {
      for (const line of poetrySection[1].split("\n")) {
        const m = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(?:\{[^}]*version\s*=\s*)?["']([^"']*)["']/);
        if (m) {
          const name = m[1].replace(/_/g, "-").toLowerCase();
          if (name !== "python") deps.push({ name, specifier: m[2] });
        }
      }
    }
  }

  // requirements.txt style embedded in pyproject (uv, hatch) — [tool.uv] dependencies or similar
  // Handled separately via requirements.txt path

  return deps;
}

/** Parse requirements.txt and extract dependency names + version specifiers. */
function parseRequirementsTxt(content: string): Array<{ name: string; specifier: string }> {
  const deps: Array<{ name: string; specifier: string }> = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const m = line.match(/^([a-zA-Z0-9_.-]+)([^;#\s]*)/);
    if (m) {
      deps.push({
        name: m[1].replace(/_/g, "-").toLowerCase(),
        specifier: m[2],
      });
    }
  }
  return deps;
}

/** Extract the pinned version number from a specifier like ">=1.0,<2" or "==1.2.3" or "^1.0". */
function extractPinnedVersion(specifier: string): string | null {
  // Exact pin: ==1.2.3
  const exact = specifier.match(/==\s*(\d[\d.]*)/);
  if (exact) return exact[1];
  // Upper bound only: <2.0 or <=1.x
  const upper = specifier.match(/<=?\s*(\d[\d.]*)/);
  if (upper) return upper[1];
  // Caret/tilde: ^1.2 ~1.2
  const caret = specifier.match(/[~^]\s*(\d[\d.]*)/);
  if (caret) return caret[1];
  // Lower bound with upper: >=1.0,<2 → use lower as "current"
  const lower = specifier.match(/>=\s*(\d[\d.]*)/);
  if (lower) return lower[1];
  return null;
}

/** Query PyPI JSON API for the latest version of a package. */
async function queryPyPI(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      headers: { Accept: "application/json", "User-Agent": "upshift-cli/0.5.0" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { info?: { version?: string; name?: string } };
    return data.info?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * PyPI-native Python scanning — no virtualenv, poetry, or pip required.
 * Parses pyproject.toml or requirements.txt directly and checks PyPI JSON API.
 */
export async function getPythonOutdatedPyPI(cwd: string): Promise<OutdatedEntry[]> {
  let deps: Array<{ name: string; specifier: string }> = [];

  const pyprojectPath = path.join(cwd, "pyproject.toml");
  const requirementsPath = path.join(cwd, "requirements.txt");

  if (existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, "utf-8");
    deps = parsePyprojectDeps(content);
  }

  if (deps.length === 0 && existsSync(requirementsPath)) {
    const content = readFileSync(requirementsPath, "utf-8");
    deps = parseRequirementsTxt(content);
  }

  if (deps.length === 0) return [];

  // Concurrently query PyPI for all deps (cap concurrency to avoid rate limits)
  const results: OutdatedEntry[] = [];
  const BATCH = 10;
  for (let i = 0; i < deps.length; i += BATCH) {
    const batch = deps.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async ({ name, specifier }) => {
        const latest = await queryPyPI(name);
        if (!latest) return null;
        const current = extractPinnedVersion(specifier);
        if (!current) return null;
        // Normalise: strip trailing zeros for comparison
        if (current === latest) return null;
        // Skip pre-release-only packages (latest contains 'a'/'b'/'rc' but current is stable)
        if (/[a-zA-Z]/.test(latest) && !/[a-zA-Z]/.test(current)) return null;
        return { name, current, wanted: latest, latest } satisfies OutdatedEntry;
      })
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) results.push(s.value);
    }
  }

  return results;
}

/** Scan Python (pip list --outdated or poetry, with PyPI fallback). */
export async function getPythonOutdated(cwd: string): Promise<OutdatedEntry[]> {
  if (existsSync(path.join(cwd, "pyproject.toml"))) {
    try {
      const result = await runCommand("poetry", ["show", "--outdated"], cwd, [0, 1]);
      const lines = result.stdout.trim().split("\n");
      const entries: OutdatedEntry[] = [];
      for (const line of lines) {
        const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)/);
        if (match) {
          entries.push({
            name: match[1],
            current: match[2],
            wanted: match[3],
            latest: match[3],
          });
        }
      }
      if (entries.length > 0) return entries;
    } catch {
      // fallback
    }
  }

  try {
    const result = await runCommand("pip", ["list", "--outdated", "--format=json"], cwd, [0, 1]);
    const parsed = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      version: string;
      latest_version?: string;
    }>;
    if (parsed.length > 0) {
      return parsed.map((p) => ({
        name: p.name,
        current: p.version,
        wanted: p.latest_version ?? p.version,
        latest: p.latest_version ?? p.version,
      }));
    }
  } catch {
    // fallback
  }

  // PyPI-native fallback — no tools required
  return getPythonOutdatedPyPI(cwd);
}

/**
 * Detect diamond dependency conflicts in a Python project.
 * Reads pyproject.toml/requirements.txt for upper-bound pins and queries PyPI
 * to identify which transitive dep is causing the constraint.
 */
export async function detectPythonDiamondConflicts(cwd: string): Promise<DiamondConflict[]> {
  const conflicts: DiamondConflict[] = [];
  let rawContent = "";

  const pyprojectPath = path.join(cwd, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    rawContent = readFileSync(pyprojectPath, "utf-8");
  }

  const deps = parsePyprojectDeps(rawContent);
  if (deps.length === 0) return [];

  // Find packages with upper-bound pins (potential diamond constraints)
  const upperBound = deps.filter(({ specifier }) => /</.test(specifier) || /,/.test(specifier) || /==/.test(specifier));

  if (upperBound.length === 0) return [];

  // For each pinned package, query PyPI to see if a newer version exists
  await Promise.allSettled(
    upperBound.map(async ({ name, specifier }) => {
      const latest = await queryPyPI(name);
      if (!latest) return;
      const current = extractPinnedVersion(specifier);
      if (!current || current === latest) return;

      // Try to find the comment in pyproject.toml explaining why
      const linePattern = new RegExp(`${name}[^\\n]*\\n?[^\\n]*#([^\\n]+)`, "i");
      const commentMatch = rawContent.match(linePattern);
      const comment = commentMatch?.[1]?.trim() ?? "";

      // Check which other dep in this project might be enforcing the constraint
      // by querying PyPI for each other dep's requires_dist
      const blockedBy: string[] = [];
      const depsToCheck = deps.filter((d) => d.name !== name).slice(0, 20); // cap for perf

      await Promise.allSettled(
        depsToCheck.map(async ({ name: depName }) => {
          try {
            const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(depName)}/json`, {
              headers: { Accept: "application/json", "User-Agent": "upshift-cli/0.5.0" },
            });
            if (!res.ok) return;
            const data = (await res.json()) as {
              info?: { requires_dist?: string[] };
            };
            const requires = data.info?.requires_dist ?? [];
            const constraining = requires.find((r) => r.toLowerCase().startsWith(name.toLowerCase()) && /</.test(r));
            if (constraining) blockedBy.push(depName);
          } catch {
            // skip
          }
        })
      );

      const constraintType = /==/.test(specifier)
        ? "exact version pin"
        : /</.test(specifier)
          ? "upper-bound constraint"
          : "version constraint";

      const explanation =
        blockedBy.length > 0
          ? `${name} is pinned at ${current} (latest: ${latest}) because ${blockedBy.join(", ")} requires an older version. Upgrade ${blockedBy.join(" or ")} first.${comment ? ` Note: ${comment}` : ""}`
          : `${name} has an ${constraintType} (spec: ${specifier.trim() || "unknown"}, latest available: ${latest}).${comment ? ` Reason: ${comment}` : blockedBy.length === 0 ? " Check which dependency enforces this." : ""}`;

      conflicts.push({
        package: name,
        pinnedAt: current,
        latestAvailable: latest,
        blockedBy,
        explanation,
      });
    })
  );

  return conflicts;
}

// ---------------------------------------------------------------------------
// Ruby scanning
// ---------------------------------------------------------------------------

/** Scan Ruby (bundle outdated). */
export async function getRubyOutdated(cwd: string): Promise<OutdatedEntry[]> {
  try {
    const result = await runCommand("bundle", ["outdated", "--strict", "--parseable"], cwd, [0, 1]);
    const entries: OutdatedEntry[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      const match = line.match(/^(\S+)\s+\(.*?(\d+\.\d+.*?)\)\s+.*?(\d+\.\d+.*?)\)/);
      if (match) {
        entries.push({
          name: match[1],
          current: match[2],
          wanted: match[3],
          latest: match[3],
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Go scanning
// ---------------------------------------------------------------------------

/** Scan Go (go list -m -u all). Output is one JSON object per line. */
export async function getGoOutdated(cwd: string): Promise<OutdatedEntry[]> {
  try {
    const result = await runCommand("go", ["list", "-m", "-u", "-json", "all"], cwd, [0, 1]);
    const entries: OutdatedEntry[] = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { Path?: string; Version?: string; Update?: { Version: string } };
        if (obj.Path && obj.Version && obj.Update?.Version && obj.Update.Version !== obj.Version) {
          entries.push({
            name: obj.Path,
            current: obj.Version,
            wanted: obj.Update.Version,
            latest: obj.Update.Version,
          });
        }
      } catch {
        // skip
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rust / Cargo scanning
// ---------------------------------------------------------------------------

/** Parse Cargo.toml and extract dependency names + version strings. */
function parseCargoToml(content: string): Array<{ name: string; version: string }> {
  const deps: Array<{ name: string; version: string }> = [];
  // Match [dependencies], [dev-dependencies], [build-dependencies]
  // No m flag: $ matches end-of-string; \n\[ matches the next section header
  const sections = content.matchAll(/\[((?:dev-|build-)?dependencies)\]([\s\S]+?)(?=\n\[|$)/g);
  for (const section of sections) {
    const body = section[2];
    for (const line of body.split("\n")) {
      // Simple: name = "1.2.3" or name = "^1.2"
      const simple = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*["']([^"']*)["']/);
      if (simple) {
        const ver = simple[2].replace(/^[^0-9]*/, ""); // strip ^ ~ >= etc.
        if (ver) deps.push({ name: simple[1], version: ver });
        continue;
      }
      // Table form: name = { version = "1.2.3", features = [...] }
      const table = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{[^}]*version\s*=\s*["']([^"']*)["']/);
      if (table) {
        const ver = table[2].replace(/^[^0-9]*/, "");
        if (ver) deps.push({ name: table[1], version: ver });
      }
    }
  }
  // Deduplicate by name (keep first)
  const seen = new Set<string>();
  return deps.filter(({ name }) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Query crates.io API for the latest version of a crate. */
async function queryCratesIo(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "upshift-cli/0.5.0 (https://upshiftai.dev)",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { crate?: { newest_version?: string } };
    return data.crate?.newest_version ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan Rust project for outdated dependencies.
 * Tries `cargo outdated --format json` first (requires cargo-outdated tool),
 * then falls back to parsing Cargo.toml + querying crates.io directly.
 */
export async function getCargoOutdated(cwd: string): Promise<OutdatedEntry[]> {
  // Try cargo outdated (most accurate — considers semver compatibility)
  try {
    const result = await runCommand("cargo", ["outdated", "--format", "json"], cwd, [0, 1]);
    const data = JSON.parse(result.stdout) as {
      dependencies?: Array<{
        name: string;
        project: string;
        compat: string;
        latest: string;
      }>;
    };
    if (data.dependencies && data.dependencies.length > 0) {
      return data.dependencies
        .filter((d) => d.latest !== "Removed" && d.project !== d.latest)
        .map((d) => ({
          name: d.name,
          current: d.project,
          wanted: d.compat !== "---" ? d.compat : d.latest,
          latest: d.latest,
        }));
    }
  } catch {
    // cargo outdated not installed or failed — fall through to crates.io API
  }

  // Fallback: parse Cargo.toml + crates.io API
  const cargoTomlPath = path.join(cwd, "Cargo.toml");
  if (!existsSync(cargoTomlPath)) return [];

  const content = readFileSync(cargoTomlPath, "utf-8");
  const deps = parseCargoToml(content);
  if (deps.length === 0) return [];

  const results: OutdatedEntry[] = [];
  const BATCH = 8; // crates.io rate limit: 1 req/sec per IP for anonymous; use small batches
  for (let i = 0; i < deps.length; i += BATCH) {
    const batch = deps.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async ({ name, version }) => {
        const latest = await queryCratesIo(name);
        if (!latest) return null;
        if (version === latest) return null;
        // Simple semver comparison: if latest > current, flag it
        if (semverGt(latest, version)) {
          return { name, current: version, wanted: latest, latest } satisfies OutdatedEntry;
        }
        return null;
      })
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) results.push(s.value);
    }
    // Respect crates.io crawl-delay
    if (i + BATCH < deps.length) await sleep(300);
  }

  return results;
}

/**
 * Check Cargo project for security advisories using the RustSec advisory database
 * via `cargo audit --json`. Returns structured advisory data.
 */
export async function getCargoAudit(cwd: string): Promise<{
  vulnerabilities: Array<{
    id: string;
    package: string;
    version: string;
    title: string;
    severity?: string;
    url?: string;
  }>;
  warnings: Array<{ id: string; package: string; kind: string; title: string }>;
}> {
  try {
    const result = await runCommand("cargo", ["audit", "--json"], cwd, [0, 1]);
    const data = JSON.parse(result.stdout) as {
      vulnerabilities?: {
        found: boolean;
        list?: Array<{
          advisory: { id: string; title: string; url?: string; cvss?: { score?: number } };
          package: { name: string; version: string };
        }>;
      };
      warnings?: Record<
        string,
        Array<{
          advisory: { id: string; title: string };
          package: { name: string; version: string };
          kind: string;
        }>
      >;
    };

    const vulnerabilities = (data.vulnerabilities?.list ?? []).map((v) => ({
      id: v.advisory.id,
      package: v.package.name,
      version: v.package.version,
      title: v.advisory.title,
      url: v.advisory.url,
      severity:
        v.advisory.cvss?.score != null
          ? v.advisory.cvss.score >= 9.0
            ? "critical"
            : v.advisory.cvss.score >= 7.0
              ? "high"
              : v.advisory.cvss.score >= 4.0
                ? "medium"
                : "low"
          : undefined,
    }));

    const warnings: Array<{ id: string; package: string; kind: string; title: string }> = [];
    for (const [, items] of Object.entries(data.warnings ?? {})) {
      for (const w of items) {
        warnings.push({
          id: w.advisory.id,
          package: w.package.name,
          kind: w.kind,
          title: w.advisory.title,
        });
      }
    }

    return { vulnerabilities, warnings };
  } catch {
    return { vulnerabilities: [], warnings: [] };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Naive semver greater-than check (major.minor.patch). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
