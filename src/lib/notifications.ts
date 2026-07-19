export type NotificationChannel = "slack" | "discord" | "webhook";

export type NotificationPayload = {
  title: string;
  message: string;
  level: "info" | "warning" | "error" | "success";
  details?: {
    outdatedCount?: number;
    vulnerabilityCount?: number;
    criticalCount?: number;
    packages?: Array<{ name: string; current: string; latest: string }>;
  };
  url?: string;
};

export type NotificationConfig = {
  slack?: {
    webhookUrl: string;
    channel?: string;
  };
  discord?: {
    webhookUrl: string;
  };
  webhook?: {
    url: string;
    headers?: Record<string, string>;
  };
};

export async function sendNotification(payload: NotificationPayload, config?: NotificationConfig): Promise<void> {
  const notifyConfig = config ?? getNotificationConfig();

  const promises: Promise<void>[] = [];

  if (notifyConfig.slack?.webhookUrl) {
    promises.push(sendSlackNotification(payload, notifyConfig.slack.webhookUrl, notifyConfig.slack.channel));
  }

  if (notifyConfig.discord?.webhookUrl) {
    promises.push(sendDiscordNotification(payload, notifyConfig.discord.webhookUrl));
  }

  if (notifyConfig.webhook?.url) {
    promises.push(sendGenericWebhook(payload, notifyConfig.webhook.url, notifyConfig.webhook.headers));
  }

  await Promise.allSettled(promises);
}

function getNotificationConfig(): NotificationConfig {
  // Check environment variables
  const config: NotificationConfig = {};

  const slackUrl = process.env.UPSHIFT_SLACK_WEBHOOK;
  if (slackUrl) {
    config.slack = {
      webhookUrl: slackUrl,
      channel: process.env.UPSHIFT_SLACK_CHANNEL,
    };
  }

  const discordUrl = process.env.UPSHIFT_DISCORD_WEBHOOK;
  if (discordUrl) {
    config.discord = { webhookUrl: discordUrl };
  }

  const webhookUrl = process.env.UPSHIFT_WEBHOOK_URL;
  if (webhookUrl) {
    config.webhook = { url: webhookUrl };
  }

  return config;
}

async function sendSlackNotification(
  payload: NotificationPayload,
  webhookUrl: string,
  channel?: string
): Promise<void> {
  const color = {
    info: "#2196F3",
    warning: "#FF9800",
    error: "#F44336",
    success: "#4CAF50",
  }[payload.level];

  const fields: Array<{ title: string; value: string; short: boolean }> = [];

  if (payload.details?.outdatedCount !== undefined) {
    fields.push({
      title: "Outdated Packages",
      value: String(payload.details.outdatedCount),
      short: true,
    });
  }

  if (payload.details?.vulnerabilityCount !== undefined) {
    fields.push({
      title: "Vulnerabilities",
      value: String(payload.details.vulnerabilityCount),
      short: true,
    });
  }

  if (payload.details?.criticalCount !== undefined && payload.details.criticalCount > 0) {
    fields.push({
      title: "Critical",
      value: String(payload.details.criticalCount),
      short: true,
    });
  }

  const slackPayload = {
    channel,
    attachments: [
      {
        color,
        title: payload.title,
        text: payload.message,
        fields,
        footer: "Upshift",
        footer_icon: "https://upshiftai.dev/favicon.svg",
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackPayload),
  });
}

async function sendDiscordNotification(payload: NotificationPayload, webhookUrl: string): Promise<void> {
  const color = {
    info: 0x2196f3,
    warning: 0xff9800,
    error: 0xf44336,
    success: 0x4caf50,
  }[payload.level];

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  if (payload.details?.outdatedCount !== undefined) {
    fields.push({
      name: "Outdated",
      value: String(payload.details.outdatedCount),
      inline: true,
    });
  }

  if (payload.details?.vulnerabilityCount !== undefined) {
    fields.push({
      name: "Vulnerabilities",
      value: String(payload.details.vulnerabilityCount),
      inline: true,
    });
  }

  if (payload.details?.criticalCount !== undefined && payload.details.criticalCount > 0) {
    fields.push({
      name: "Critical",
      value: String(payload.details.criticalCount),
      inline: true,
    });
  }

  // Add top packages if available
  if (payload.details?.packages && payload.details.packages.length > 0) {
    const packageList = payload.details.packages
      .slice(0, 5)
      .map((p) => `• ${p.name}: ${p.current} → ${p.latest}`)
      .join("\n");

    fields.push({
      name: "Top Updates",
      value: packageList,
      inline: false,
    });
  }

  const discordPayload = {
    embeds: [
      {
        title: payload.title,
        description: payload.message,
        color,
        fields,
        url: payload.url,
        footer: {
          text: "Upshift",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(discordPayload),
  });
}

async function sendGenericWebhook(
  payload: NotificationPayload,
  url: string,
  headers?: Record<string, string>
): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
      source: "upshift",
    }),
  });
}

export function createScanNotification(
  outdatedCount: number,
  vulnerabilityCount: number,
  criticalCount: number,
  packages?: Array<{ name: string; current: string; latest: string }>
): NotificationPayload {
  let level: NotificationPayload["level"] = "info";
  let title = "Upshift Scan Complete";
  let message = "";

  if (criticalCount > 0) {
    level = "error";
    title = "🚨 Critical Vulnerabilities Found";
    message = `Found ${criticalCount} critical vulnerabilities that need immediate attention.`;
  } else if (vulnerabilityCount > 0) {
    level = "warning";
    title = "⚠️ Security Vulnerabilities Found";
    message = `Found ${vulnerabilityCount} vulnerabilities in your dependencies.`;
  } else if (outdatedCount > 0) {
    level = "info";
    title = "📦 Outdated Dependencies";
    message = `Found ${outdatedCount} packages that can be updated.`;
  } else {
    level = "success";
    title = "✅ All Clear";
    message = "All dependencies are up to date with no known vulnerabilities.";
  }

  return {
    title,
    message,
    level,
    details: {
      outdatedCount,
      vulnerabilityCount,
      criticalCount,
      packages,
    },
    url: "https://upshiftai.dev",
  };
}

export function createUpgradeNotification(succeeded: number, failed: number, _packages: string[]): NotificationPayload {
  const level = failed > 0 ? "warning" : "success";
  const title = failed > 0 ? "⚠️ Upgrade Completed with Errors" : "✅ Upgrade Complete";
  const message = `Upgraded ${succeeded} packages${failed > 0 ? `, ${failed} failed` : ""}.`;

  return {
    title,
    message,
    level,
    details: {
      outdatedCount: succeeded + failed,
    },
  };
}
