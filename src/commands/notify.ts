import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { sendNotification, createScanNotification, type NotificationConfig } from "../lib/notifications.js";
import { getOutdatedPackages, detectPackageManager, type PackageManager } from "../lib/package-manager.js";
import { getVulnerabilitySummaryForDirectory } from "../lib/scan.js";
import { validateOrExit, webhookUrlSchema } from "../lib/validate.js";

export function notifyCommand(): Command {
  return new Command("notify")
    .description("Send scan results to Slack, Discord, or webhook")
    .option("--slack <url>", "Slack webhook URL")
    .option("--discord <url>", "Discord webhook URL")
    .option("--webhook <url>", "Generic webhook URL")
    .option("--test", "Send a test notification")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (options) => {
      if (options.slack) validateOrExit(webhookUrlSchema, options.slack);
      if (options.discord) validateOrExit(webhookUrlSchema, options.discord);
      if (options.webhook) validateOrExit(webhookUrlSchema, options.webhook);

      try {
        await runNotify(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

async function auditTotalsForNotify(
  cwd: string,
  pm: PackageManager
): Promise<{ vulnerabilityCount: number; criticalCount: number }> {
  return getVulnerabilitySummaryForDirectory(cwd, pm);
}

async function runNotify(options: {
  slack?: string;
  discord?: string;
  webhook?: string;
  test?: boolean;
  cwd: string;
}): Promise<void> {
  // Build config from options or environment
  const config: NotificationConfig = {};

  if (options.slack || process.env.UPSHIFT_SLACK_WEBHOOK) {
    config.slack = {
      webhookUrl: options.slack || process.env.UPSHIFT_SLACK_WEBHOOK!,
    };
  }

  if (options.discord || process.env.UPSHIFT_DISCORD_WEBHOOK) {
    config.discord = {
      webhookUrl: options.discord || process.env.UPSHIFT_DISCORD_WEBHOOK!,
    };
  }

  if (options.webhook || process.env.UPSHIFT_WEBHOOK_URL) {
    config.webhook = {
      url: options.webhook || process.env.UPSHIFT_WEBHOOK_URL!,
    };
  }

  if (!config.slack && !config.discord && !config.webhook) {
    console.log(chalk.yellow("No notification channels configured.\n"));
    console.log("Configure with:");
    console.log(chalk.cyan("  --slack <webhook-url>") + "     Slack incoming webhook");
    console.log(chalk.cyan("  --discord <webhook-url>") + "   Discord webhook");
    console.log(chalk.cyan("  --webhook <url>") + "           Generic HTTP POST");
    console.log("");
    console.log("Or set environment variables:");
    console.log(chalk.gray("  UPSHIFT_SLACK_WEBHOOK"));
    console.log(chalk.gray("  UPSHIFT_DISCORD_WEBHOOK"));
    console.log(chalk.gray("  UPSHIFT_WEBHOOK_URL"));
    return;
  }

  // Test mode
  if (options.test) {
    const spinner = ora("Sending test notification...").start();

    try {
      await sendNotification(
        {
          title: "🧪 Upshift Test Notification",
          message: "This is a test notification from Upshift CLI.",
          level: "info",
          details: {
            outdatedCount: 5,
            vulnerabilityCount: 2,
            criticalCount: 1,
          },
        },
        config
      );

      spinner.succeed("Test notification sent!");
      console.log(chalk.gray("\nCheck your configured channels for the message."));
    } catch (error) {
      spinner.fail("Failed to send notification");
      throw error;
    }
    return;
  }

  // Scan and notify
  const spinner = ora("Scanning dependencies...").start();

  try {
    const pm = detectPackageManager(options.cwd);
    const outdated = await getOutdatedPackages(options.cwd, pm);

    const outdatedCount = outdated.length;
    const { vulnerabilityCount, criticalCount } = await auditTotalsForNotify(options.cwd, pm);

    const topPackages = outdated.slice(0, 5).map((p) => ({
      name: p.name,
      current: p.current,
      latest: p.latest,
    }));

    spinner.text = "Sending notification...";

    const payload = createScanNotification(outdatedCount, vulnerabilityCount, criticalCount, topPackages);

    await sendNotification(payload, config);

    spinner.succeed("Notification sent!");
    const vulnLine =
      vulnerabilityCount > 0 ? `, ${vulnerabilityCount} vulnerabilities (${criticalCount} critical)` : "";
    console.log(chalk.gray(`\nReported ${outdatedCount} outdated package(s)${vulnLine}.`));
  } catch (error) {
    spinner.fail("Failed");
    throw error;
  }
}
