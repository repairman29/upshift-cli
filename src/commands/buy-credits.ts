import { Command } from "commander";
import { openUrl } from "../lib/open.js";

export function buyCreditsCommand(): Command {
  const command = new Command("buy-credits");
  command
    .description("Purchase credit packs via Stripe checkout")
    .option("--pack <size>", "Pack size: small, medium, large", "small")
    .option("--endpoint <url>", "Billing endpoint URL")
    .option("--token <token>", "Billing token")
    .action(async (options) => {
      const pack = String(options.pack ?? "small");
      if (!["small", "medium", "large"].includes(pack)) {
        throw new Error("Invalid pack. Use small, medium, or large.");
      }

      const endpoint = options.endpoint ?? process.env.UPSHIFT_CREDITS_ENDPOINT ?? "";
      const token = options.token ?? process.env.UPSHIFT_API_TOKEN ?? "";
      if (!endpoint || !token) {
        throw new Error("Missing endpoint or token. Set UPSHIFT_CREDITS_ENDPOINT and UPSHIFT_API_TOKEN.");
      }

      const response = await fetch(`${endpoint}/billing/checkout/credits`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pack, token }),
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
      process.stdout.write("Opened checkout in your browser.\n");
    });

  return command;
}
