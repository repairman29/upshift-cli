import { Command } from "commander";
import { openUrl } from "../lib/open.js";

export function subscribeCommand(): Command {
  const command = new Command("subscribe");
  command
    .description("Open Stripe checkout for Pro or Team subscription")
    .option("--tier <tier>", "Subscription tier: pro, team", "pro")
    .option("--endpoint <url>", "Billing endpoint URL")
    .option("--token <token>", "Billing token")
    .action(async (options) => {
      const tier = String(options.tier ?? "pro").toLowerCase();
      if (tier !== "pro" && tier !== "team") {
        throw new Error("Invalid tier. Use pro or team.");
      }

      const endpoint = options.endpoint ?? process.env.UPSHIFT_CREDITS_ENDPOINT ?? "";
      const token = options.token ?? process.env.UPSHIFT_API_TOKEN ?? "";
      if (!endpoint || !token) {
        throw new Error("Missing endpoint or token. Set UPSHIFT_CREDITS_ENDPOINT and UPSHIFT_API_TOKEN.");
      }

      const response = await fetch(`${endpoint}/billing/checkout/subscription`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tier, token }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Checkout failed: ${response.status} ${text}`);
      }

      const data = (await response.json()) as { url?: string };
      if (!data.url) {
        throw new Error("Checkout URL missing from response.");
      }

      await openUrl(data.url);
      process.stdout.write(`Opened ${tier} subscription checkout in your browser.\n`);
    });

  return command;
}
