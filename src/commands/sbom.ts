import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export function sbomCommand(): Command {
  return new Command("sbom")
    .description("Export a Software Bill of Materials (CycloneDX 1.4 JSON)")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--output <file>", "Output file (default: sbom.json)")
    .option("--format <format>", "Format: cyclonedx | spdx", "cyclonedx")
    .option("--include-dev", "Include devDependencies in the SBOM", false)
    .option("--json", "Print to stdout instead of writing file")
    .action(async (options) => {
      if (options.format !== "cyclonedx" && options.format !== "spdx") {
        console.error(chalk.red("Unsupported format. Use: cyclonedx or spdx"));
        process.exit(1);
      }

      const spinner = ora("Reading dependency manifest...").start();

      try {
        const cwd = path.resolve(options.cwd);
        const pkgPath = path.join(cwd, "package.json");

        if (!fs.existsSync(pkgPath)) {
          spinner.fail("No package.json found");
          process.exit(1);
        }

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        const deps: Record<string, string> = {
          ...(pkg.dependencies ?? {}),
          ...(options.includeDev ? (pkg.devDependencies ?? {}) : {}),
        };

        spinner.text = "Building SBOM...";

        let output: string;
        if (options.format === "spdx") {
          output = buildSpdxSbom(pkg, deps, cwd);
        } else {
          output = buildCycloneDxSbom(pkg, deps, cwd);
        }

        spinner.stop();

        if (options.json) {
          process.stdout.write(output + "\n");
          return;
        }

        const outFile = options.output ?? "sbom.json";
        const outPath = path.resolve(options.output ? options.output : path.join(cwd, outFile));
        fs.writeFileSync(outPath, output, "utf8");

        const componentCount = Object.keys(deps).length;
        console.log(chalk.green(`✔ SBOM written to ${outPath}`));
        console.log(
          chalk.gray(
            `  Format: ${options.format === "spdx" ? "SPDX 2.3" : "CycloneDX 1.4"} · ${componentCount} component${componentCount !== 1 ? "s" : ""}`
          )
        );
        console.log(chalk.gray(`  Project: ${pkg.name ?? path.basename(cwd)} ${pkg.version ?? "?"}`));
      } catch (err) {
        spinner.fail("SBOM generation failed");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function buildCycloneDxSbom(pkg: any, deps: Record<string, string>, cwd: string): string {
  const serialNumber = `urn:uuid:${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const components = Object.entries(deps).map(([name, versionRange]) => {
    // Strip range specifiers to get a clean version for the SBOM
    const version = versionRange
      .replace(/^[\^~>=<]/, "")
      .replace(/\s.*$/, "")
      .trim();

    // Try to read actual installed version from node_modules
    let installedVersion = version;
    try {
      const installedPkg = JSON.parse(fs.readFileSync(path.join(cwd, "node_modules", name, "package.json"), "utf8"));
      installedVersion = installedPkg.version ?? version;
    } catch {
      // Not installed — use declared version
    }

    const purl = `pkg:npm/${name.startsWith("@") ? name.slice(1) : name}@${installedVersion}`;

    return {
      type: "library",
      "bom-ref": purl,
      name,
      version: installedVersion,
      purl,
      externalReferences: [
        {
          type: "website",
          url: `https://www.npmjs.com/package/${name}`,
        },
      ],
    };
  });

  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.4",
    serialNumber,
    version: 1,
    metadata: {
      timestamp: now,
      tools: [{ vendor: "Upshift", name: "upshift-cli", version: "latest" }],
      component: {
        type: "application",
        name: pkg.name ?? path.basename(cwd),
        version: pkg.version ?? "0.0.0",
        description: pkg.description ?? undefined,
        purl: pkg.name ? `pkg:npm/${pkg.name}@${pkg.version ?? "0.0.0"}` : undefined,
      },
    },
    components,
  };

  return JSON.stringify(sbom, null, 2);
}

function buildSpdxSbom(pkg: any, deps: Record<string, string>, cwd: string): string {
  const now = new Date().toISOString();
  const projectName = pkg.name ?? path.basename(cwd);
  const projectVersion = pkg.version ?? "0.0.0";

  const packages = Object.entries(deps).map(([name, versionRange]) => {
    const version = versionRange
      .replace(/^[\^~>=<]/, "")
      .replace(/\s.*$/, "")
      .trim();
    let installedVersion = version;
    try {
      const installedPkg = JSON.parse(fs.readFileSync(path.join(cwd, "node_modules", name, "package.json"), "utf8"));
      installedVersion = installedPkg.version ?? version;
    } catch {
      // Not installed
    }

    return [
      `PackageName: ${name}`,
      `SPDXID: SPDXRef-Package-${name.replace(/[^a-zA-Z0-9-]/g, "-")}`,
      `PackageVersion: ${installedVersion}`,
      `PackageDownloadLocation: https://registry.npmjs.org/${name}/-/${name}-${installedVersion}.tgz`,
      `FilesAnalyzed: false`,
      `ExternalRef: PACKAGE-MANAGER purl pkg:npm/${name}@${installedVersion}`,
      `PackageLicenseConcluded: NOASSERTION`,
      `PackageLicenseDeclared: NOASSERTION`,
      `PackageCopyrightText: NOASSERTION`,
      "",
    ].join("\n");
  });

  const header = [
    `SPDXVersion: SPDX-2.3`,
    `DataLicense: CC0-1.0`,
    `SPDXID: SPDXRef-DOCUMENT`,
    `DocumentName: ${projectName}`,
    `DocumentNamespace: https://upshiftai.dev/sbom/${projectName}-${projectVersion}-${Date.now()}`,
    `Creator: Tool: upshift-cli`,
    `Created: ${now}`,
    ``,
    `PackageName: ${projectName}`,
    `SPDXID: SPDXRef-Package-root`,
    `PackageVersion: ${projectVersion}`,
    `PackageDownloadLocation: NOASSERTION`,
    `FilesAnalyzed: false`,
    `PackageLicenseConcluded: NOASSERTION`,
    `PackageLicenseDeclared: NOASSERTION`,
    `PackageCopyrightText: NOASSERTION`,
    ``,
  ].join("\n");

  // Note: SPDX is text format, not JSON. Return as JSON wrapper for consistency.
  return JSON.stringify({ format: "SPDX-2.3", content: header + packages.join("\n") }, null, 2);
}
