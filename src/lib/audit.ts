import chalk from "chalk";
import ora from "ora";
import { existsSync } from "fs";
import path from "path";
import { runCommand } from "./exec.js";
import { consumeCredit } from "./credits.js";

export type AuditOptions = {
  cwd: string;
  json?: boolean;
  ai?: boolean;
  fix?: boolean;
};

export type Vulnerability = {
  name: string;
  severity: "info" | "low" | "moderate" | "high" | "critical";
  title: string;
  url?: string;
  range: string;
  fixAvailable: boolean;
  fixVersion?: string;
  isDirect: boolean;
};

export type AuditResult = {
  vulnerabilities: Vulnerability[];
  summary: {
    total: number;
    critical: number;
    high: number;
    moderate: number;
    low: number;
    info: number;
  };
  aiRemediation?: string;
};

export async function runAudit(options: AuditOptions): Promise<void> {
  if (options.ai) {
    await consumeCredit("audit", 2);
  }

  const spinner = ora("Running security audit...").start();

  try {
    const packageManager = detectPackageManager(options.cwd);

    if (packageManager !== "npm") {
      throw new Error("Only npm is supported for audit currently.");
    }

    const result = await runCommand("npm", ["audit", "--json"], options.cwd, [0, 1, 2]);
    const auditData = parseNpmAudit(result.stdout);

    if (auditData.vulnerabilities.length === 0) {
      spinner.succeed("No vulnerabilities found!");
      return;
    }

    spinner.succeed(`Found ${auditData.vulnerabilities.length} vulnerabilities`);

    // Get AI remediation if requested
    if (options.ai) {
      const aiSpinner = ora("Generating AI remediation plan...").start();
      auditData.aiRemediation = await getAIRemediation(auditData);
      aiSpinner.succeed("AI analysis complete");
    }

    // JSON output
    if (options.json) {
      process.stdout.write(JSON.stringify(auditData, null, 2) + "\n");
      return;
    }

    // Human-readable output
    renderAuditResults(auditData);

    // Auto-fix if requested
    if (options.fix) {
      await runAutoFix(options.cwd, auditData);
    }
  } catch (error) {
    spinner.fail("Audit failed");
    throw error;
  }
}

function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" {
  const pnpmLock = path.join(cwd, "pnpm-lock.yaml");
  const yarnLock = path.join(cwd, "yarn.lock");

  if (existsSync(pnpmLock)) return "pnpm";
  if (existsSync(yarnLock)) return "yarn";
  return "npm";
}

function parseNpmAudit(stdout: string): AuditResult {
  if (!stdout.trim()) {
    return {
      vulnerabilities: [],
      summary: { total: 0, critical: 0, high: 0, moderate: 0, low: 0, info: 0 },
    };
  }

  const data = JSON.parse(stdout) as {
    vulnerabilities?: Record<
      string,
      {
        name: string;
        severity: string;
        via: Array<string | { title?: string; url?: string }>;
        range: string;
        fixAvailable: boolean | { name: string; version: string };
        isDirect?: boolean;
      }
    >;
    metadata?: {
      vulnerabilities?: Record<string, number>;
    };
  };

  const vulnerabilities: Vulnerability[] = Object.values(data.vulnerabilities ?? {}).map((v) => ({
    name: v.name,
    severity: v.severity as Vulnerability["severity"],
    title: extractTitle(v.via),
    url: extractUrl(v.via),
    range: v.range,
    fixAvailable: Boolean(v.fixAvailable),
    fixVersion: typeof v.fixAvailable === "object" ? v.fixAvailable.version : undefined,
    isDirect: v.isDirect ?? false,
  }));

  const counts = data.metadata?.vulnerabilities ?? {};

  return {
    vulnerabilities,
    summary: {
      total: vulnerabilities.length,
      critical: counts.critical ?? 0,
      high: counts.high ?? 0,
      moderate: counts.moderate ?? 0,
      low: counts.low ?? 0,
      info: counts.info ?? 0,
    },
  };
}

function extractTitle(via: Array<string | { title?: string }>): string {
  for (const v of via) {
    if (typeof v === "object" && v.title) return v.title;
    if (typeof v === "string") return v;
  }
  return "Unknown vulnerability";
}

function extractUrl(via: Array<string | { url?: string }>): string | undefined {
  for (const v of via) {
    if (typeof v === "object" && v.url) return v.url;
  }
  return undefined;
}

async function getAIRemediation(auditData: AuditResult): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey && baseURL.includes("openai.com")) {
    return (
      "AI remediation unavailable (OPENAI_API_KEY not configured).\n" +
      "Or use a local model: set OPENAI_BASE_URL=http://127.0.0.1:1234/v1 and OPENAI_MODEL=qwen/qwen3-14b"
    );
  }

  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: apiKey || "dummy", baseURL });

  const vulnSummary = auditData.vulnerabilities
    .slice(0, 10) // Limit to 10 for token efficiency
    .map(
      (v) =>
        `- ${v.name} (${v.severity}): ${v.title}${v.fixAvailable ? ` [fix: ${v.fixVersion ?? "available"}]` : " [no fix]"}`
    )
    .join("\n");

  const systemPrompt = `You are a security engineer helping developers remediate npm vulnerabilities.
Provide a prioritized remediation plan with specific commands to run.
Focus on:
1. Critical/high vulnerabilities first
2. Direct dependencies over transitive
3. Breaking changes to watch for
4. Alternative packages if no fix exists

Be concise and actionable. Format with clear sections.`;

  const userPrompt = `Analyze these vulnerabilities and provide a remediation plan:

Summary: ${auditData.summary.critical} critical, ${auditData.summary.high} high, ${auditData.summary.moderate} moderate

Vulnerabilities:
${vulnSummary}

Provide:
1. Priority order for fixing
2. Specific npm commands to run
3. Any breaking changes to watch for
4. Alternatives for packages without fixes`;

  const response = await openai.chat.completions.create({
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 1000,
    temperature: 0.3,
  });

  return response.choices[0]?.message?.content ?? "Unable to generate remediation plan.";
}

function renderAuditResults(auditData: AuditResult): void {
  const { summary, vulnerabilities } = auditData;

  // Summary
  process.stdout.write(chalk.bold("\nVulnerability Summary:\n"));

  if (summary.critical > 0) {
    process.stdout.write(chalk.red(`  Critical: ${summary.critical}\n`));
  }
  if (summary.high > 0) {
    process.stdout.write(chalk.red(`  High:     ${summary.high}\n`));
  }
  if (summary.moderate > 0) {
    process.stdout.write(chalk.yellow(`  Moderate: ${summary.moderate}\n`));
  }
  if (summary.low > 0) {
    process.stdout.write(chalk.gray(`  Low:      ${summary.low}\n`));
  }

  // Detailed list (critical and high only for brevity)
  const important = vulnerabilities.filter((v) => v.severity === "critical" || v.severity === "high");

  if (important.length > 0) {
    process.stdout.write(chalk.bold("\nCritical & High Severity:\n"));

    for (const vuln of important) {
      const severityColor = vuln.severity === "critical" ? chalk.bgRed.white : chalk.red;
      const fixStatus = vuln.fixAvailable
        ? chalk.green(`✔ fix: ${vuln.fixVersion ?? "npm audit fix"}`)
        : chalk.yellow("✖ no fix available");

      process.stdout.write(`\n  ${severityColor(` ${vuln.severity.toUpperCase()} `)} ${chalk.bold(vuln.name)}\n`);
      process.stdout.write(chalk.gray(`    ${vuln.title}\n`));
      process.stdout.write(`    ${fixStatus}\n`);
      if (vuln.url) {
        process.stdout.write(chalk.gray(`    ${vuln.url}\n`));
      }
    }
  }

  // AI Remediation
  if (auditData.aiRemediation) {
    process.stdout.write(chalk.bold.cyan("\n🤖 AI Remediation Plan:\n\n"));
    process.stdout.write(auditData.aiRemediation + "\n");
  }

  // Quick actions
  process.stdout.write(chalk.bold("\nQuick Actions:\n"));
  process.stdout.write(chalk.cyan("  npm audit fix") + "           - Auto-fix compatible updates\n");
  process.stdout.write(chalk.cyan("  npm audit fix --force") + "   - Fix all (may include breaking changes)\n");
  process.stdout.write(chalk.cyan("  upshift audit --ai") + "      - Get AI remediation plan (2 credits)\n");
}

async function runAutoFix(cwd: string, auditData: AuditResult): Promise<void> {
  const fixable = auditData.vulnerabilities.filter((v) => v.fixAvailable);

  if (fixable.length === 0) {
    process.stdout.write(chalk.yellow("\nNo auto-fixable vulnerabilities found.\n"));
    return;
  }

  const spinner = ora(`Fixing ${fixable.length} vulnerabilities...`).start();

  try {
    await runCommand("npm", ["audit", "fix"], cwd);
    spinner.succeed(`Fixed ${fixable.length} vulnerabilities`);
  } catch {
    spinner.fail("Some fixes failed - run `npm audit fix --force` for breaking changes");
  }
}
