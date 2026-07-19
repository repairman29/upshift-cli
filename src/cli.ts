#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "module";
import { scanCommand } from "./commands/scan.js";
import { explainCommand } from "./commands/explain.js";
import { fixCommand } from "./commands/fix.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { rollbackCommand } from "./commands/rollback.js";
import { auditCommand } from "./commands/audit.js";
import { interactiveCommand } from "./commands/interactive.js";
import { workspacesCommand } from "./commands/workspaces.js";
import { notifyCommand } from "./commands/notify.js";
import { initCommand } from "./commands/init.js";
import { creditsCommand } from "./commands/credits.js";
import { buyCreditsCommand } from "./commands/buy-credits.js";
import { subscribeCommand } from "./commands/subscribe.js";
import { statusCommand } from "./commands/status.js";
import { suggestCommand } from "./commands/suggest.js";
import { planCommand } from "./commands/plan.js";
import { radarCommand } from "./commands/radar.js";
import { sbomCommand } from "./commands/sbom.js";
import { badgeCommand } from "./commands/badge.js";
import { licenseCommand } from "./commands/license.js";
import { debtCommand } from "./commands/debt.js";
import { changelogCommand } from "./commands/changelog.js";
import { releaseCommand } from "./commands/release.js";
import { doctorCommand } from "./commands/doctor.js";
import { compareCommand } from "./commands/compare.js";
import { migrateCommand } from "./commands/migrate.js";
import { prDescriptionCommand } from "./commands/pr-description.js";
import { scheduleCommand } from "./commands/schedule.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();

program
  .name("upshift")
  .description("AI-powered dependency upgrades with explanations and safe rollbacks.")
  .version(pkg.version);

// Core workflow
program.addCommand(scanCommand());
program.addCommand(explainCommand());
program.addCommand(fixCommand());
program.addCommand(upgradeCommand());
program.addCommand(rollbackCommand());
program.addCommand(auditCommand());
program.addCommand(suggestCommand());
program.addCommand(planCommand());
program.addCommand(radarCommand());
program.addCommand(sbomCommand());
program.addCommand(badgeCommand());
program.addCommand(licenseCommand());
program.addCommand(debtCommand());
program.addCommand(changelogCommand());
program.addCommand(compareCommand());
program.addCommand(releaseCommand());
program.addCommand(migrateCommand());
program.addCommand(prDescriptionCommand());
program.addCommand(scheduleCommand());

// Interactive & Monorepo
program.addCommand(interactiveCommand());
program.addCommand(workspacesCommand());

// Notifications
program.addCommand(notifyCommand());

// Setup
program.addCommand(initCommand());
program.addCommand(doctorCommand());

// Billing
program.addCommand(creditsCommand());
program.addCommand(buyCreditsCommand());
program.addCommand(subscribeCommand());
program.addCommand(statusCommand());

program.parse(process.argv);
