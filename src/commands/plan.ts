import { Command } from "commander";
import { runPlan } from "../lib/plan.js";

export function planCommand(): Command {
  return new Command("plan")
    .description("Multi-step upgrade plan: ordered list of upgrades (dependency order, risk)")
    .option("--json", "Output as JSON", false)
    .option("--mode <mode>", "all | minor | patch", "all")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      const mode = (options.mode ?? "all") as "all" | "minor" | "patch";
      await runPlan({
        cwd: options.cwd,
        json: options.json,
        mode: ["all", "minor", "patch"].includes(mode) ? mode : "all",
      });
    });
}
