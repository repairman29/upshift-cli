import { Command } from "commander";
import { existsSync, writeFileSync } from "fs";
import path from "path";
import chalk from "chalk";
import { createConfigTemplate } from "../lib/config.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Create a .upshiftrc.json config file")
    .option("--force", "Overwrite existing config file")
    .action(async (options) => {
      const cwd = process.cwd();
      const configPath = path.join(cwd, ".upshiftrc.json");

      if (existsSync(configPath) && !options.force) {
        console.log(chalk.yellow("Config file already exists: .upshiftrc.json"));
        console.log(chalk.gray("Use --force to overwrite."));
        return;
      }

      const template = createConfigTemplate();
      writeFileSync(configPath, template, "utf8");

      console.log(chalk.green("✔ Created .upshiftrc.json"));
      console.log("");
      console.log(chalk.bold("  Getting started with Upshift:"));
      console.log("");
      console.log(chalk.cyan("  Core workflow"));
      console.log(chalk.gray("    upshift scan              ") + "Scan for outdated packages + vulnerabilities");
      console.log(chalk.gray("    upshift radar --score     ") + "Get A-F dependency health score");
      console.log(chalk.gray("    upshift upgrade <pkg>     ") + "Safe single-package upgrade with rollback");
      console.log(chalk.gray("    upshift migrate <pkg>     ") + "AST-aware major version migration");
      console.log(chalk.gray("    upshift audit --ai        ") + "AI-powered vulnerability remediation");
      console.log("");
      console.log(chalk.cyan("  Analysis"));
      console.log(chalk.gray("    upshift explain <pkg>     ") + "Explain a package and its upgrade risk");
      console.log(chalk.gray("    upshift debt              ") + "Calculate total upgrade debt (hours + cost)");
      console.log(chalk.gray("    upshift license           ") + "License compliance scan");
      console.log(chalk.gray("    upshift changelog <pkg>   ") + "Fetch release notes from GitHub");
      console.log(chalk.gray("    upshift sbom              ") + "Export CycloneDX SBOM");
      console.log(chalk.gray("    upshift badge             ") + "Generate README health badge");
      console.log(chalk.gray("    upshift compare <pkg> A B ") + "Side-by-side version comparison");
      console.log(chalk.gray("    upshift suggest           ") + "AI-ranked upgrade suggestions with confidence");
      console.log(chalk.gray("    upshift doctor            ") + "Diagnose environment and configuration");
      console.log("");
      console.log(chalk.cyan("  Automation"));
      console.log(chalk.gray("    upshift schedule install  ") + "Add GitHub Actions workflow for scheduled scans");
      console.log(chalk.gray("    upshift notify --slack    ") + "Send scan results to Slack");
      console.log(chalk.gray("    upshift pr-description    ") + "Generate PR description for pending upgrades");
      console.log(chalk.gray("    upshift release           ") + "Generate CHANGELOG from git history");
      console.log(chalk.gray("    upshift workspaces --score") + "Monorepo fleet health scores");
      console.log("");
      console.log(chalk.gray("  Edit .upshiftrc.json to customize behavior."));
      console.log(chalk.gray("  Docs: https://upshiftai.dev/docs"));
      console.log("");
    });
}
