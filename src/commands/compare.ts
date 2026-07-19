/**
 * upshift compare <package> <versionA> <versionB>
 *
 * Side-by-side comparison of two versions of a package:
 * - Bundle size (from Bundlephobia)
 * - Downloads per week (npm)
 * - Dependencies count
 * - License
 * - Age / publish date
 * - Community confidence (from Upshift API)
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";

interface NpmVersionData {
  version: string;
  description?: string;
  license?: string | { type: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
  time?: string;
  dist?: { tarball?: string; unpackedSize?: number };
}

interface NpmDownloads {
  downloads: number;
  package: string;
  start: string;
  end: string;
}

interface BundlephobiaData {
  size: number;
  gzip: number;
  dependencyCount: number;
  version: string;
  errorMessage?: string;
}

export function compareCommand(): Command {
  return new Command("compare")
    .description("Compare two versions of a package (size, downloads, deps, license)")
    .argument("<package>", "Package name")
    .argument("<versionA>", "First version to compare")
    .argument("<versionB>", "Second version to compare (use latest for latest)")
    .option("--json", "Output as JSON")
    .action(async (packageName: string, versionA: string, versionB: string, options) => {
      const spinner = ora(`Fetching data for ${packageName}...`).start();

      try {
        // Resolve "latest" to an actual version
        if (versionB === "latest" || versionA === "latest") {
          const latestRes = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
          if (latestRes.ok) {
            const latest = (await latestRes.json()) as { version?: string };
            if (versionA === "latest") versionA = latest.version ?? versionA;
            if (versionB === "latest") versionB = latest.version ?? versionB;
          }
        }

        // Fetch both versions in parallel
        const [dataA, dataB, downloadsA, downloadsB] = await Promise.all([
          fetchVersionData(packageName, versionA),
          fetchVersionData(packageName, versionB),
          fetchWeeklyDownloads(packageName, versionA),
          fetchWeeklyDownloads(packageName, versionB),
        ]);

        // Bundlephobia (best-effort, may not have all versions)
        const [bundleA, bundleB] = await Promise.all([
          fetchBundleSize(packageName, versionA),
          fetchBundleSize(packageName, versionB),
        ]);

        // Confidence from Upshift API
        const confidence = await fetchConfidence(packageName, versionA, versionB);

        spinner.stop();

        if (options.json) {
          process.stdout.write(
            JSON.stringify(
              {
                package: packageName,
                versions: {
                  [versionA]: { npm: dataA, downloads: downloadsA?.downloads, bundle: bundleA },
                  [versionB]: { npm: dataB, downloads: downloadsB?.downloads, bundle: bundleB },
                },
                confidence,
              },
              null,
              2
            ) + "\n"
          );
          return;
        }

        // Pretty table output
        console.log("");
        console.log(chalk.bold(`  ${packageName}  ${chalk.cyan(versionA)}  vs  ${chalk.green(versionB)}`));
        console.log("");

        const row = (label: string, a: string, b: string, prefer?: "lower" | "higher" | "none") => {
          const aFmt =
            prefer === "lower"
              ? parseFloat(a) < parseFloat(b)
                ? chalk.green(a)
                : parseFloat(a) > parseFloat(b)
                  ? chalk.red(a)
                  : a
              : prefer === "higher"
                ? parseFloat(a) > parseFloat(b)
                  ? chalk.green(a)
                  : parseFloat(a) < parseFloat(b)
                    ? chalk.red(a)
                    : a
                : a;
          const bFmt =
            prefer === "lower"
              ? parseFloat(b) < parseFloat(a)
                ? chalk.green(b)
                : parseFloat(b) > parseFloat(a)
                  ? chalk.red(b)
                  : b
              : prefer === "higher"
                ? parseFloat(b) > parseFloat(a)
                  ? chalk.green(b)
                  : parseFloat(b) < parseFloat(a)
                    ? chalk.red(b)
                    : b
                : b;
          const labelPad = label.padEnd(22);
          const aPad = aFmt.padEnd(20 + (aFmt.length - a.length)); // adjust for chalk codes
          console.log(`  ${chalk.gray(labelPad)}  ${aPad}  ${bFmt}`);
        };

        const headerA = chalk.cyan(versionA).padEnd(20 + (chalk.cyan(versionA).length - versionA.length));
        console.log(`  ${"".padEnd(22)}  ${headerA}  ${chalk.green(versionB)}`);
        console.log(`  ${chalk.gray("─".repeat(60))}`);

        // License
        const licA = normalizeLicense(dataA?.license);
        const licB = normalizeLicense(dataB?.license);
        row("License", licA, licB, "none");

        // Published date
        const dateA = dataA?.time ? new Date(dataA.time).toLocaleDateString() : "—";
        const dateB = dataB?.time ? new Date(dataB.time).toLocaleDateString() : "—";
        row("Published", dateA, dateB, "none");

        // Dependencies count
        const depsA = Object.keys(dataA?.dependencies ?? {}).length;
        const depsB = Object.keys(dataB?.dependencies ?? {}).length;
        row("Dependencies", String(depsA), String(depsB), "lower");

        // Weekly downloads
        const dlA = downloadsA?.downloads ?? 0;
        const dlB = downloadsB?.downloads ?? 0;
        row("Weekly downloads", fmtNum(dlA), fmtNum(dlB), "higher");

        // Bundle size (gzip)
        if (bundleA || bundleB) {
          const gzA = bundleA?.gzip ?? null;
          const gzB = bundleB?.gzip ?? null;
          row("Bundle (gzip)", gzA != null ? fmtBytes(gzA) : "—", gzB != null ? fmtBytes(gzB) : "—", "lower");
          const sizeA = bundleA?.size ?? null;
          const sizeB = bundleB?.size ?? null;
          row(
            "Bundle (minified)",
            sizeA != null ? fmtBytes(sizeA) : "—",
            sizeB != null ? fmtBytes(sizeB) : "—",
            "lower"
          );
        }

        // Unpackaged size
        const upsA = dataA?.dist?.unpackedSize ?? null;
        const upsB = dataB?.dist?.unpackedSize ?? null;
        if (upsA != null || upsB != null) {
          row("Unpacked size", upsA != null ? fmtBytes(upsA) : "—", upsB != null ? fmtBytes(upsB) : "—", "lower");
        }

        console.log("");

        // Confidence
        if (confidence) {
          if (confidence.confidence != null) {
            const gradeColor =
              confidence.grade === "high" ? chalk.green : confidence.grade === "medium" ? chalk.yellow : chalk.red;
            console.log(
              `  ${chalk.gray("Community confidence")}   ${gradeColor(`${confidence.confidence}%`)}  ${chalk.gray(`(${confidence.totalSignals} signal${confidence.totalSignals !== 1 ? "s" : ""} · ${confidence.grade}`)}`
            );
          } else {
            console.log(`  ${chalk.gray("Community confidence")}   No signals yet for this transition`);
          }
          console.log("");
        }

        console.log(chalk.gray(`  npm: https://www.npmjs.com/package/${packageName}/v/${versionB}`));
        if (bundleB) {
          console.log(chalk.gray(`  Bundlephobia: https://bundlephobia.com/package/${packageName}@${versionB}`));
        }
        console.log("");
      } catch (err) {
        spinner.fail("Comparison failed");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function fetchVersionData(pkg: string, version: string): Promise<NpmVersionData | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/${version}`);
    if (!res.ok) return null;
    return (await res.json()) as NpmVersionData;
  } catch {
    return null;
  }
}

async function fetchWeeklyDownloads(pkg: string, _version: string): Promise<NpmDownloads | null> {
  // npm downloads API doesn't filter by version — returns total package downloads
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);
    if (!res.ok) return null;
    return (await res.json()) as NpmDownloads;
  } catch {
    return null;
  }
}

async function fetchBundleSize(pkg: string, version: string): Promise<BundlephobiaData | null> {
  try {
    const res = await fetch(
      `https://bundlephobia.com/api/size?package=${encodeURIComponent(pkg)}@${encodeURIComponent(version)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as BundlephobiaData;
    return data.errorMessage ? null : data;
  } catch {
    return null;
  }
}

async function fetchConfidence(pkg: string, from: string, to: string) {
  const apiBase = process.env.UPSHIFT_API_URL || "https://upshiftai.dev";
  try {
    const res = await fetch(
      `${apiBase}/api/confidence?package=${encodeURIComponent(pkg)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    return (await res.json()) as { confidence: number | null; grade: string | null; totalSignals: number };
  } catch {
    return null;
  }
}

function normalizeLicense(lic: unknown): string {
  if (!lic) return "—";
  if (typeof lic === "string") return lic;
  if (typeof lic === "object" && lic !== null && "type" in lic) return String((lic as { type: string }).type);
  return "—";
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1_024) return `${(b / 1_024).toFixed(1)} kB`;
  return `${b} B`;
}
