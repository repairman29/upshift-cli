import { Command } from "commander";
import { runRollback, listBackups } from "../lib/rollback.js";

export function rollbackCommand(): Command {
  return new Command("rollback")
    .description("Rollback to a previous state after an upgrade")
    .option("-i, --interactive", "Select a specific backup to restore")
    .option("-l, --list", "List available backups")
    .option("--clean", "Delete all backups")
    .option("-y, --yes", "Skip confirmation (restores the latest backup; required in non-interactive shells)")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      try {
        if (options.list) {
          await listBackups(options.cwd);
          return;
        }

        await runRollback({
          cwd: options.cwd,
          interactive: options.interactive,
          all: options.clean,
          yes: options.yes,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
