import { Command } from "commander";
import { runUpgrade } from "../lib/upgrade.js";
import { runBatchUpgrade } from "../lib/batch-upgrade.js";
import { validateOrExit, fsPathSchema, packageNameSchema, versionSchema } from "../lib/validate.js";

export function upgradeCommand(): Command {
  const command = new Command("upgrade");
  command
    .description("Upgrade dependencies (single package or batch mode)")
    .argument("[package]", "Package name to upgrade (omit for batch mode)")
    .option("--to <version>", "Target version (default: latest)")
    .option("--all", "Upgrade all outdated packages to latest")
    .option("--all-minor", "Upgrade all packages with minor/patch updates")
    .option("--all-patch", "Upgrade all packages with patch updates only")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--dry-run", "Show planned changes without modifying files", false)
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--skip-tests", "Skip running tests after upgrade")
    .action(async (pkg, options) => {
      validateOrExit(fsPathSchema, options.cwd);

      // Batch mode
      if (options.all || options.allMinor || options.allPatch) {
        const mode = options.all ? "all" : options.allMinor ? "minor" : "patch";
        try {
          await runBatchUpgrade({
            cwd: options.cwd,
            mode,
            dryRun: options.dryRun,
            yes: options.yes,
            skipTests: options.skipTests,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          console.error(`Error: ${message}`);
          process.exit(1);
        }
        return;
      }

      // Single package mode
      if (!pkg) {
        console.error("Error: Package name required (or use --all, --all-minor, --all-patch for batch mode)");
        process.exit(1);
      }

      validateOrExit(packageNameSchema, pkg);
      if (options.to) validateOrExit(versionSchema, options.to);

      try {
        await runUpgrade({
          cwd: options.cwd,
          packageName: pkg,
          toVersion: options.to,
          dryRun: options.dryRun,
          yes: options.yes,
          skipTests: options.skipTests,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  return command;
}
