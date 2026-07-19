import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";
import chalk from "chalk";

type CreditState = {
  balance: number;
  updatedAt: string;
};

const DEFAULT_CREDITS = 10;

function showOutOfCreditsMessage(needed: number = 1): void {
  console.log("");
  console.log(chalk.yellow(`⚠ Not enough credits (need ${needed})`));
  console.log("");
  console.log("  AI features require credits. Get more:");
  console.log("");
  console.log(chalk.cyan("  upshift buy-credits --pack small") + "   → 100 credits for $5");
  console.log(chalk.cyan("  upshift buy-credits --pack medium") + "  → 300 credits for $12");
  console.log(chalk.cyan("  upshift buy-credits --pack large") + "   → 1000 credits for $35");
  console.log("");
  console.log(chalk.cyan("  upshift subscribe --tier pro") + "       → $12/mo (unlimited AI; see pricing.json)");
  console.log(
    chalk.cyan("  upshift subscribe --tier team") + "      → $39/mo (unlimited AI, up to 10 seats; see pricing.json)"
  );
  console.log("");
  console.log(chalk.dim("  Credit costs: explain --ai = 1, fix = 3"));
  console.log(chalk.dim("  Canonical numbers: see pricing.json in the upshift repo"));
  console.log("");
}

function envTruthy(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Custom OPENAI_BASE_URL (LM Studio, Ollama, etc.) no longer skips credits by default.
 * Set UPSHIFT_SKIP_CREDITS_FOR_LOCAL_LLM=1 to restore the old behavior (honor-system opt-in).
 */
export async function consumeCredit(action: string, count: number = 1): Promise<void> {
  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  const isNonHostedOpenAI = Boolean(baseURL && !baseURL.includes("api.openai.com"));
  if (isNonHostedOpenAI && envTruthy("UPSHIFT_SKIP_CREDITS_FOR_LOCAL_LLM")) {
    return;
  }

  const endpoint = process.env.UPSHIFT_CREDITS_ENDPOINT;
  const token = process.env.UPSHIFT_API_TOKEN;
  const orgId = process.env.UPSHIFT_ORG?.trim();

  // Org pool path: UPSHIFT_ORG + UPSHIFT_CREDITS_ENDPOINT + UPSHIFT_API_TOKEN
  if (orgId && endpoint && token) {
    const ok = await consumeOrgRemote(endpoint, token, orgId, action, count);
    if (ok) return;
    // Fall through to per-user remote if org endpoint fails
  }

  // Per-user remote path
  if (endpoint && token) {
    const ok = await consumeRemote(endpoint, token, action, count);
    if (ok) return;
  }

  // Local fallback
  const state = loadCredits();
  if (state.balance < count) {
    showOutOfCreditsMessage(count);
    process.exit(2);
  }

  const next = {
    balance: state.balance - count,
    updatedAt: new Date().toISOString(),
  };
  saveCredits(next);

  // Warn when credits are running low
  if (next.balance > 0 && next.balance <= 5) {
    console.log("");
    console.log(chalk.yellow(`⚠ ${next.balance} credit${next.balance === 1 ? "" : "s"} remaining`));
    console.log(chalk.dim("  Run: upshift buy-credits --pack small"));
  }
}

export function getCreditBalance(): number {
  return loadCredits().balance;
}

export function addCredits(amount: number): void {
  const state = loadCredits();
  const next = {
    balance: state.balance + amount,
    updatedAt: new Date().toISOString(),
  };
  saveCredits(next);
}

export function resetCredits(amount: number): void {
  const next = {
    balance: amount,
    updatedAt: new Date().toISOString(),
  };
  saveCredits(next);
}

function loadCredits(): CreditState {
  const file = creditsFilePath();
  if (!existsSync(file)) {
    const override = getEnvCredits();
    const initial: CreditState = {
      balance: override ?? DEFAULT_CREDITS,
      updatedAt: new Date().toISOString(),
    };
    saveCredits(initial);
    return initial;
  }

  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as CreditState;
  if (typeof parsed.balance !== "number") {
    return {
      balance: DEFAULT_CREDITS,
      updatedAt: new Date().toISOString(),
    };
  }
  return parsed;
}

function saveCredits(state: CreditState): void {
  const file = creditsFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function creditsFilePath(): string {
  return path.join(os.homedir(), ".upshift", "credits.json");
}

function getEnvCredits(): number | null {
  const raw = process.env.UPSHIFT_CREDITS;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function consumeOrgRemote(
  endpoint: string,
  token: string,
  orgId: string,
  action: string,
  count: number = 1
): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/credits/consume-org`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ org_id: orgId, action, count }),
    });

    if (!response.ok) {
      if (response.status === 402 || response.status === 429) {
        showOutOfCreditsMessage(count);
        process.exit(2);
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function consumeRemote(endpoint: string, token: string, action: string, count: number = 1): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/credits/consume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, count }),
    });

    if (!response.ok) {
      if (response.status === 402 || response.status === 429) {
        showOutOfCreditsMessage(count);
        process.exit(2);
      }
      return false;
    }
    const data = (await response.json()) as { balance?: number };
    if (typeof data.balance === "number" && data.balance < 0) {
      showOutOfCreditsMessage(count);
      process.exit(2);
    }
    return true;
  } catch {
    return false;
  }
}
