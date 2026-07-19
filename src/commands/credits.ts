import { Command } from "commander";
import { getCreditBalance, addCredits, resetCredits } from "../lib/credits.js";
import { fetchBillingStatus } from "../lib/api.js";

export function creditsCommand(): Command {
  const command = new Command("credits");
  command
    .description("Show or manage your Upshift credits")
    .option("--json", "Output as JSON (when showing balance)")
    .option("--add <amount>", "Add credits to the local bank")
    .option("--reset <amount>", "Reset credit balance to a number")
    .action(async (options) => {
      const json = Boolean(options.json);

      if (options.reset) {
        const amount = Number(options.reset);
        if (!Number.isFinite(amount) || amount < 0) {
          throw new Error("Invalid reset amount");
        }
        resetCredits(amount);
        if (json) {
          process.stdout.write(JSON.stringify({ balance: amount }) + "\n");
        } else {
          process.stdout.write(`Credits reset to ${amount}\n`);
        }
        return;
      }

      if (options.add) {
        const amount = Number(options.add);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("Invalid add amount");
        }
        addCredits(amount);
        const balance = getCreditBalance();
        if (json) {
          process.stdout.write(JSON.stringify({ balance, added: amount }) + "\n");
        } else {
          process.stdout.write(`Added ${amount} credits\n`);
        }
        return;
      }

      const endpoint = process.env.UPSHIFT_CREDITS_ENDPOINT ?? "";
      const token = process.env.UPSHIFT_API_TOKEN ?? "";
      if (endpoint && token) {
        const data = await fetchBillingStatus(endpoint, token);
        if (data) {
          if (json) {
            process.stdout.write(
              JSON.stringify({
                balance: data.balance,
                tier: data.tier,
                bonusMultiplier: data.bonusMultiplier ?? 1,
                source: "remote",
              }) + "\n"
            );
          } else {
            const bonus =
              data.bonusMultiplier && data.bonusMultiplier !== 1
                ? ` (tier: ${data.tier}, ${Math.round((data.bonusMultiplier - 1) * 100)}% bonus)`
                : ` (tier: ${data.tier})`;
            process.stdout.write(`Credits: ${data.balance}${bonus}\n`);
          }
          return;
        }
      }

      const balance = getCreditBalance();
      if (json) {
        process.stdout.write(JSON.stringify({ balance, source: "local" }) + "\n");
      } else {
        process.stdout.write(`Credits: ${balance}\n`);
      }
    });

  return command;
}
