import { Command } from "commander";
import { runAudit } from "../lib/audit.js";

export function auditCommand(): Command {
  return new Command("audit")
    .description("Security audit with AI-powered remediation")
    .option("--ai", "Get AI-powered remediation plan (costs 2 credits)")
    .option("--fix", "Auto-fix vulnerabilities where possible")
    .option("--json", "Output results as JSON")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      try {
        await runAudit({
          cwd: options.cwd,
          json: options.json,
          ai: options.ai,
          fix: options.fix,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
