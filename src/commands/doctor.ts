/**
 * upshift doctor
 *
 * Diagnose the local Upshift environment: check Node version, CLI install,
 * API connectivity, env vars, package manager detection, and config validity.
 */
import { Command } from "commander";
import chalk from "chalk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Diagnose your Upshift environment and configuration")
    .option("--cwd <path>", "Project directory to diagnose", process.cwd())
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const cwd = path.resolve(options.cwd);
      const checks: Check[] = [];

      // 1. Node.js version
      const nodeVersion = process.version;
      const nodeMajor = parseInt(nodeVersion.slice(1), 10);
      checks.push({
        name: "Node.js version",
        status: nodeMajor >= 18 ? "ok" : nodeMajor >= 16 ? "warn" : "fail",
        detail:
          nodeMajor >= 18
            ? `${nodeVersion} — supported`
            : nodeMajor >= 16
              ? `${nodeVersion} — works but Node 18+ recommended`
              : `${nodeVersion} — Node 18+ required`,
      });

      // 2. Upshift CLI version
      try {
        const pkgPath = path.join(path.dirname(path.dirname(import.meta.url.replace("file://", ""))), "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath.replace(/^\//, "/"), "utf8"));
        checks.push({ name: "Upshift CLI", status: "ok", detail: `v${pkg.version}` });
      } catch {
        checks.push({ name: "Upshift CLI", status: "info", detail: "Could not read package.json version" });
      }

      // 3. Package manager detection
      const pkgJsonPath = path.join(cwd, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        const hasPnpmLock = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"));
        const hasYarnLock = fs.existsSync(path.join(cwd, "yarn.lock"));
        const hasNpmLock = fs.existsSync(path.join(cwd, "package-lock.json"));
        const pm = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : "npm";
        checks.push({ name: "Package manager", status: "ok", detail: `Detected: ${pm}` });
      } else {
        checks.push({
          name: "Package manager",
          status: "warn",
          detail: "No package.json found in cwd — run from project root",
        });
      }

      // 4. Git availability
      try {
        const gitVersion = execSync("git --version", { stdio: ["pipe", "pipe", "pipe"] })
          .toString()
          .trim();
        checks.push({ name: "Git", status: "ok", detail: gitVersion });
      } catch {
        checks.push({ name: "Git", status: "warn", detail: "Not found — rollback features require git" });
      }

      // 5. API token
      const apiToken = process.env.UPSHIFT_API_TOKEN;
      checks.push({
        name: "UPSHIFT_API_TOKEN",
        status: apiToken ? "ok" : "info",
        detail: apiToken ? `Set (${apiToken.slice(0, 8)}...)` : "Not set — needed for AI features and org credits",
      });

      // 6. Upshift API reachability
      const apiBase = process.env.UPSHIFT_API_URL || "https://upshiftai.dev";
      try {
        const res = await fetch(`${apiBase}/api/health`, {
          signal: AbortSignal.timeout(5000),
        });
        checks.push({
          name: "API reachability",
          status: res.ok ? "ok" : "warn",
          detail: res.ok ? `${apiBase} — reachable` : `${apiBase} returned ${res.status}`,
        });
      } catch {
        checks.push({
          name: "API reachability",
          status: "warn",
          detail: `Could not reach ${apiBase} — AI features unavailable`,
        });
      }

      // 7. Config file
      const configPath = path.join(cwd, ".upshiftrc.json");
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
          const keys = Object.keys(config).join(", ") || "empty";
          checks.push({ name: ".upshiftrc.json", status: "ok", detail: `Found — keys: ${keys}` });
        } catch {
          checks.push({
            name: ".upshiftrc.json",
            status: "fail",
            detail: "Found but contains invalid JSON — run: upshift init --force",
          });
        }
      } else {
        checks.push({ name: ".upshiftrc.json", status: "info", detail: "Not found — run `upshift init` to create" });
      }

      // 8. GitHub App env (optional)
      const githubAppId = process.env.GITHUB_APP_ID;
      const githubSecret = process.env.GITHUB_WEBHOOK_SECRET;
      if (githubAppId && githubSecret) {
        checks.push({ name: "GitHub App", status: "ok", detail: `App ID ${githubAppId} configured` });
      } else {
        checks.push({
          name: "GitHub App",
          status: "info",
          detail: "GITHUB_APP_ID / GITHUB_WEBHOOK_SECRET not set — optional, enables inline PR comments",
        });
      }

      // 9. Slack/Discord notify (optional)
      const slackSet = !!process.env.UPSHIFT_SLACK_WEBHOOK;
      const discordSet = !!process.env.UPSHIFT_DISCORD_WEBHOOK;
      if (slackSet || discordSet) {
        const channels = [slackSet && "Slack", discordSet && "Discord"].filter(Boolean).join(", ");
        checks.push({ name: "Notifications", status: "ok", detail: `Configured: ${channels}` });
      } else {
        checks.push({
          name: "Notifications",
          status: "info",
          detail: "No webhook configured — run `upshift notify --test` to set up",
        });
      }

      if (options.json) {
        process.stdout.write(JSON.stringify({ checks }, null, 2) + "\n");
        const hasFail = checks.some((c) => c.status === "fail");
        if (hasFail) process.exit(1);
        return;
      }

      // Pretty output
      console.log("");
      console.log(chalk.bold("  Upshift Doctor"));
      console.log("");

      for (const check of checks) {
        const icon =
          check.status === "ok"
            ? chalk.green("✔")
            : check.status === "warn"
              ? chalk.yellow("⚠")
              : check.status === "fail"
                ? chalk.red("✖")
                : chalk.gray("ℹ");
        const label = check.name.padEnd(24);
        console.log(`  ${icon}  ${chalk.gray(label)}  ${check.detail}`);
      }

      const fails = checks.filter((c) => c.status === "fail");
      const warns = checks.filter((c) => c.status === "warn");

      console.log("");
      if (fails.length > 0) {
        console.log(chalk.red(`  ${fails.length} error${fails.length !== 1 ? "s" : ""} need attention.`));
        process.exit(1);
      } else if (warns.length > 0) {
        console.log(
          chalk.yellow(`  ${warns.length} warning${warns.length !== 1 ? "s" : ""} — some features may be limited.`)
        );
      } else {
        console.log(chalk.green("  All checks passed!"));
      }
      console.log("");
    });
}
