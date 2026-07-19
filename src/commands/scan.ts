import { Command } from "commander";
import chalk from "chalk";
import { runScan } from "../lib/scan.js";
import { validateOrExit, fsPathSchema, webhookUrlSchema } from "../lib/validate.js";

export function scanCommand(): Command {
  const command = new Command("scan");
  command
    .description("Scan dependencies for updates and vulnerabilities")
    .option("--json", "Output results as JSON", false)
    .option("--licenses", "Include license for each direct dependency (npm, Python)", false)
    .option("--report <path>", "Write JSON report to file (for Radar/dashboard)")
    .option(
      "--upload",
      "Upload report to Radar Pro (requires --report, UPSHIFT_RADAR_TOKEN, UPSHIFT_RADAR_UPLOAD_URL)",
      false
    )
    .option("--cwd <path>", "Project directory to scan", process.cwd())
    .option("--org <orgId>", "Attribute this scan to an org's shared credit pool (Team plan)")
    .action(async (options) => {
      validateOrExit(fsPathSchema, options.cwd);
      if (options.report) validateOrExit(fsPathSchema, options.report);

      const uploadUrl = options.upload ? process.env.UPSHIFT_RADAR_UPLOAD_URL : undefined;
      const uploadToken = options.upload ? process.env.UPSHIFT_RADAR_TOKEN : undefined;
      if (options.upload) {
        if (!options.report) {
          console.error("Error: --upload requires --report <path>");
          process.exit(1);
        }
        if (!uploadToken || !uploadUrl) {
          console.error(
            "Error: --upload requires env UPSHIFT_RADAR_TOKEN and UPSHIFT_RADAR_UPLOAD_URL (e.g. your Supabase function URL)"
          );
          process.exit(1);
        }
        validateOrExit(webhookUrlSchema, uploadUrl);
      }
      await runScan({
        cwd: options.cwd,
        json: options.json,
        licenses: options.licenses ?? false,
        report: options.report,
        uploadUrl,
        uploadToken,
      });
      if (options.org) {
        const apiToken = process.env.UPSHIFT_API_TOKEN;
        const apiBase = process.env.UPSHIFT_API_URL || "https://upshiftai.dev";
        if (!apiToken) {
          console.error(chalk.yellow("Warning: UPSHIFT_API_TOKEN not set — org credit consumption skipped."));
        } else {
          try {
            const res = await fetch(`${apiBase}/api/credits/consume-org`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ orgId: options.org, amount: 1, command: "scan" }),
            });
            if (res.status === 402) {
              const data = await res.json();
              console.error(
                chalk.red(`Org credit limit reached (${data.remaining ?? 0} remaining). Contact your org admin.`)
              );
              process.exit(1);
            }
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              console.error(chalk.yellow(`Warning: org credit consumption failed — ${data.error || res.status}`));
            }
          } catch (err) {
            // Non-fatal — don't block the scan
            console.error(
              chalk.yellow(
                `Warning: could not reach Upshift API for org credits — ${err instanceof Error ? err.message : String(err)}`
              )
            );
          }
        }
      }
    });

  return command;
}
