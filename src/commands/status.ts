import { Command } from "commander";
import { getCreditBalance } from "../lib/credits.js";
import { fetchBillingStatus } from "../lib/api.js";

export function statusCommand(): Command {
  const command = new Command("status");
  command
    .description("Show subscription tier and credit balance (remote or local)")
    .option("--json", "Output as JSON")
    .option("--endpoint <url>", "Billing endpoint URL")
    .option("--token <token>", "Billing token")
    .action(async (options) => {
      const endpoint = options.endpoint ?? process.env.UPSHIFT_CREDITS_ENDPOINT ?? "";
      const token = options.token ?? process.env.UPSHIFT_API_TOKEN ?? "";
      const json = Boolean(options.json);
      const org = process.env.UPSHIFT_ORG?.trim() || undefined;
      const auditUrl = process.env.UPSHIFT_AUDIT_URL?.trim() || undefined;

      if (endpoint && token) {
        const data = await fetchBillingStatus(endpoint, token);
        if (!data) {
          throw new Error("Failed to fetch billing status.");
        }
        if (json) {
          process.stdout.write(
            JSON.stringify({
              tier: data.tier,
              balance: data.balance,
              bonusMultiplier: data.bonusMultiplier ?? 1,
              source: "remote",
              org,
              auditEmission: Boolean(auditUrl),
            }) + "\n"
          );
          return;
        }
        const bonusPct =
          data.bonusMultiplier && data.bonusMultiplier !== 1
            ? ` (${Math.round((data.bonusMultiplier - 1) * 100)}% bonus on packs)`
            : "";
        process.stdout.write(
          `tier: ${data.tier}\nbalance: ${data.balance}\nbonus: ${data.bonusMultiplier ?? 1}${bonusPct}\n`
        );
        if (org) process.stdout.write(`org: ${org}\n`);
        if (auditUrl) process.stdout.write("audit: emission enabled\n");
        return;
      }

      const balance = getCreditBalance();
      if (json) {
        process.stdout.write(
          JSON.stringify({
            balance,
            source: "local",
            org,
            auditEmission: Boolean(auditUrl),
          }) + "\n"
        );
        return;
      }
      process.stdout.write(`Credits: ${balance} (local)\n`);
      if (org) process.stdout.write(`org: ${org}\n`);
      if (auditUrl) process.stdout.write("audit: emission enabled\n");
      process.stdout.write("Set UPSHIFT_CREDITS_ENDPOINT and UPSHIFT_API_TOKEN for subscription status.\n");
    });

  return command;
}
