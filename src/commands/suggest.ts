import { Command } from "commander";
import { runSuggest } from "../lib/suggest.js";

export function suggestCommand(): Command {
  return new Command("suggest")
    .description("Proactive upgrade suggestions (low risk, high value). Opt-in, no telemetry.")
    .option("--json", "Output as JSON", false)
    .option("--limit <n>", "Max suggestions to show", "5")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      const limit = parseInt(options.limit, 10);
      await runSuggest({
        cwd: options.cwd,
        json: options.json,
        limit: isNaN(limit) ? 5 : limit,
      });
    });
}
