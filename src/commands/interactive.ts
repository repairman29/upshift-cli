import { Command } from "commander";
import { runInteractive } from "../lib/interactive.js";

export function interactiveCommand(): Command {
  return new Command("interactive")
    .alias("i")
    .description("Interactive mode - select packages to upgrade with a TUI")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      try {
        await runInteractive({
          cwd: options.cwd,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
