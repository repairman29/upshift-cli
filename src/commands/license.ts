import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";

/** SPDX license identifiers considered permissive */
const PERMISSIVE = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Unlicense",
  "0BSD",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
]);

/** Permissive but require attribution notices */
const NOTICE_REQUIRED = new Set(["Apache-2.0", "BSD-3-Clause", "BSD-2-Clause"]);

/** Copyleft — require source disclosure if distributed */
const COPYLEFT = new Set([
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "LGPL-2.1",
  "LGPL-3.0",
  "MPL-2.0",
  "EUPL-1.2",
  "OSL-3.0",
]);

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  licenseCategory: "permissive" | "notice-required" | "copyleft" | "unknown" | "custom";
  repository?: string;
}

export function licenseCommand(): Command {
  return new Command("license")
    .description("Scan dependencies for license compliance")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--deny <licenses>", "Comma-separated denied SPDX IDs (e.g. GPL-3.0,AGPL-3.0)")
    .option("--allow <licenses>", "Strict allowlist — only permit these SPDX IDs")
    .option("--copyleft", "Flag all copyleft licenses as violations", false)
    .option("--json", "Output as JSON", false)
    .option("--output <file>", "Write JSON report to file")
    .action(async (options) => {
      const spinner = ora("Scanning licenses...").start();

      try {
        const cwd = path.resolve(options.cwd);
        const pkgPath = path.join(cwd, "package.json");

        if (!fs.existsSync(pkgPath)) {
          spinner.fail("No package.json found");
          process.exit(1);
        }

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const deps: Record<string, string> = { ...pkg.dependencies };
        const entries: LicenseEntry[] = [];

        for (const [name, versionRange] of Object.entries(deps)) {
          const instPath = path.join(cwd, "node_modules", name, "package.json");
          let license = "UNKNOWN";
          let version = String(versionRange).replace(/^[\^~>=<]/, "");
          let repository: string | undefined;

          try {
            const instPkg = JSON.parse(fs.readFileSync(instPath, "utf8"));
            version = instPkg.version ?? version;
            license = Array.isArray(instPkg.license)
              ? instPkg.license.join(" OR ")
              : (instPkg.license?.type ?? instPkg.license ?? "UNKNOWN");
            repository = instPkg.repository?.url ?? instPkg.repository;
          } catch {
            // Not installed
          }

          const spdx = license.replace(/^\(/, "").replace(/\)$/, "").trim();
          let category: LicenseEntry["licenseCategory"];
          if (!spdx || spdx === "UNKNOWN") category = "unknown";
          else if (COPYLEFT.has(spdx)) category = "copyleft";
          else if (NOTICE_REQUIRED.has(spdx)) category = "notice-required";
          else if (PERMISSIVE.has(spdx)) category = "permissive";
          else category = "custom";

          entries.push({ name, version, license: spdx || "UNKNOWN", licenseCategory: category, repository });
        }

        spinner.stop();

        const denySet = options.deny
          ? new Set(options.deny.split(",").map((s: string) => s.trim()))
          : new Set<string>();
        const allowSet: Set<string> | null = options.allow
          ? new Set(options.allow.split(",").map((s: string) => s.trim()))
          : null;

        const violations: LicenseEntry[] = [];
        for (const e of entries) {
          if (denySet.has(e.license)) {
            violations.push(e);
            continue;
          }
          if (options.copyleft && e.licenseCategory === "copyleft") {
            violations.push(e);
            continue;
          }
          if (allowSet && !allowSet.has(e.license)) {
            violations.push(e);
            continue;
          }
        }

        const byCategory = {
          permissive: entries.filter((e) => e.licenseCategory === "permissive").length,
          noticeRequired: entries.filter((e) => e.licenseCategory === "notice-required").length,
          copyleft: entries.filter((e) => e.licenseCategory === "copyleft").length,
          unknown: entries.filter((e) => e.licenseCategory === "unknown").length,
          custom: entries.filter((e) => e.licenseCategory === "custom").length,
        };

        const report = {
          scanned: entries.length,
          violations: violations.length,
          byCategory,
          violationList: violations,
          entries,
        };

        if (options.output) {
          fs.writeFileSync(options.output, JSON.stringify(report, null, 2), "utf8");
          console.log(chalk.green(`✔ License report written to ${options.output}`));
        }

        if (options.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + "\n");
          if (violations.length > 0) process.exit(1);
          return;
        }

        console.log("");
        console.log(chalk.bold("  License Compliance Report"));
        console.log("");
        console.log(`  Scanned: ${entries.length} packages`);
        console.log(`  ${chalk.green(`Permissive:      ${byCategory.permissive}`)}`);
        console.log(`  ${chalk.cyan(`Notice required: ${byCategory.noticeRequired}`)}`);
        console.log(`  ${chalk.yellow(`Copyleft:        ${byCategory.copyleft}`)}`);
        console.log(`  ${chalk.gray(`Unknown:         ${byCategory.unknown}`)}`);
        if (byCategory.custom > 0) console.log(`  Custom/other:    ${byCategory.custom}`);
        console.log("");

        if (violations.length > 0) {
          console.log(
            chalk.red.bold(`  ✖ ${violations.length} license violation${violations.length !== 1 ? "s" : ""}:`)
          );
          console.log("");
          for (const v of violations) {
            console.log(`  ${chalk.red(v.name)} ${chalk.gray(`v${v.version}`)}  ${chalk.yellow(v.license)}`);
          }
          console.log("");
          process.exit(1);
        }

        const copyleftPkgs = entries.filter((e) => e.licenseCategory === "copyleft");
        if (copyleftPkgs.length > 0 && !options.copyleft) {
          console.log(chalk.yellow("  ⚠ Copyleft (review distribution requirements):"));
          for (const p of copyleftPkgs) {
            console.log(chalk.yellow(`    ${p.name}  ${p.license}`));
          }
          console.log("");
        }

        console.log(chalk.green("  ✔ No license violations found."));
        console.log("");
        console.log(chalk.gray("  CI tip: upshift license --deny GPL-3.0,AGPL-3.0 --copyleft"));
        console.log("");
      } catch (err) {
        spinner.fail("License scan failed");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
