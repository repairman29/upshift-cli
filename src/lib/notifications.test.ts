import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendNotification,
  createScanNotification,
  createUpgradeNotification,
  type NotificationPayload,
  type NotificationConfig,
} from "./notifications.js";

describe("notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.UPSHIFT_SLACK_WEBHOOK;
    delete process.env.UPSHIFT_SLACK_CHANNEL;
    delete process.env.UPSHIFT_DISCORD_WEBHOOK;
    delete process.env.UPSHIFT_WEBHOOK_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("sendNotification", () => {
    it("formats Slack body with attachments[0].color === '#F44336' for error level and includes channel when given", async () => {
      const fetchStub = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchStub);

      const payload: NotificationPayload = {
        title: "Test Error",
        message: "Something failed",
        level: "error",
      };
      const config: NotificationConfig = {
        slack: {
          webhookUrl: "https://hooks.slack.com/services/test",
          channel: "#alerts",
        },
      };

      const results = await sendNotification(payload, config);

      expect(results).toEqual([{ channel: "slack", ok: true, status: 200 }]);
      expect(fetchStub).toHaveBeenCalledOnce();
      const [url, options] = fetchStub.mock.calls[0];
      expect(url).toBe("https://hooks.slack.com/services/test");
      const body = JSON.parse(options.body as string);
      expect(body.channel).toBe("#alerts");
      expect(body.attachments[0].color).toBe("#F44336");
    });

    it("formats Discord embeds[0].color === 0xf44336, capping 'Top Updates' at 5", async () => {
      const fetchStub = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchStub);

      const payload: NotificationPayload = {
        title: "Security Issue",
        message: "Action required",
        level: "error",
        details: {
          packages: [
            { name: "pkg1", current: "1.0.0", latest: "2.0.0" },
            { name: "pkg2", current: "1.0.0", latest: "2.0.0" },
            { name: "pkg3", current: "1.0.0", latest: "2.0.0" },
            { name: "pkg4", current: "1.0.0", latest: "2.0.0" },
            { name: "pkg5", current: "1.0.0", latest: "2.0.0" },
            { name: "pkg6", current: "1.0.0", latest: "2.0.0" },
            { name: "pkg7", current: "1.0.0", latest: "2.0.0" },
          ],
        },
      };
      const config: NotificationConfig = {
        discord: {
          webhookUrl: "https://discord.com/api/webhooks/test",
        },
      };

      const results = await sendNotification(payload, config);

      expect(results).toEqual([{ channel: "discord", ok: true, status: 200 }]);
      expect(fetchStub).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchStub.mock.calls[0][1].body as string);
      expect(body.embeds[0].color).toBe(0xf44336);
      const topUpdatesField = body.embeds[0].fields.find((f: { name: string }) => f.name === "Top Updates");
      expect(topUpdatesField).toBeDefined();
      const lines = topUpdatesField.value.split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe("• pkg1: 1.0.0 → 2.0.0");
      expect(lines[4]).toBe("• pkg5: 1.0.0 → 2.0.0");
    });

    it("generic webhook merges custom headers and adds source: 'upshift'", async () => {
      const fetchStub = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchStub);

      const payload: NotificationPayload = {
        title: "Generic Notice",
        message: "Hello webhook",
        level: "info",
      };
      const config: NotificationConfig = {
        webhook: {
          url: "https://example.com/webhook",
          headers: {
            "X-Custom-Auth": "secret-token",
          },
        },
      };

      const results = await sendNotification(payload, config);

      expect(results).toEqual([{ channel: "webhook", ok: true, status: 200 }]);
      expect(fetchStub).toHaveBeenCalledOnce();
      const [url, options] = fetchStub.mock.calls[0];
      expect(url).toBe("https://example.com/webhook");
      expect(options.headers["X-Custom-Auth"]).toBe("secret-token");
      expect(options.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(options.body as string);
      expect(body.source).toBe("upshift");
      expect(body.title).toBe("Generic Notice");
    });

    it("returns ok: false, status: 500 when server returns 500", async () => {
      const fetchStub = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
      vi.stubGlobal("fetch", fetchStub);

      const payload: NotificationPayload = {
        title: "Test",
        message: "Testing 500",
        level: "info",
      };
      const config: NotificationConfig = {
        webhook: {
          url: "https://example.com/webhook",
        },
      };

      const results = await sendNotification(payload, config);

      expect(results).toEqual([
        {
          channel: "webhook",
          ok: false,
          status: 500,
        },
      ]);
    });

    it("returns ok: false, error: ... when fetch is rejected", async () => {
      const fetchStub = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", fetchStub);

      const payload: NotificationPayload = {
        title: "Test",
        message: "Testing rejection",
        level: "info",
      };
      const config: NotificationConfig = {
        webhook: {
          url: "http://127.0.0.1:9/hook",
        },
      };

      const results = await sendNotification(payload, config);

      expect(results).toEqual([
        {
          channel: "webhook",
          ok: false,
          error: "Connection refused",
        },
      ]);
    });

    it("does not stop other channels when one channel fails (all three fetch calls made)", async () => {
      const fetchStub = vi.fn().mockImplementation((url: string) => {
        if (url.includes("slack")) {
          return Promise.reject(new Error("Slack failed"));
        }
        if (url.includes("discord")) {
          return Promise.resolve(new Response("Not Found", { status: 404 }));
        }
        return Promise.resolve(new Response("OK", { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchStub);

      const payload: NotificationPayload = {
        title: "Multi-channel Test",
        message: "Testing resiliency",
        level: "warning",
      };
      const config: NotificationConfig = {
        slack: { webhookUrl: "https://hooks.slack.com/services/test" },
        discord: { webhookUrl: "https://discord.com/api/webhooks/test" },
        webhook: { url: "https://example.com/hook" },
      };

      const results = await sendNotification(payload, config);

      expect(fetchStub).toHaveBeenCalledTimes(3);
      expect(results).toEqual([
        { channel: "slack", ok: false, error: "Slack failed" },
        { channel: "discord", ok: false, status: 404 },
        { channel: "webhook", ok: true, status: 200 },
      ]);
    });
  });

  describe("createScanNotification", () => {
    it("picks error when criticalCount > 0", () => {
      const notification = createScanNotification(10, 5, 2);
      expect(notification.level).toBe("error");
      expect(notification.title).toContain("Critical");
    });

    it("picks warning when criticalCount === 0 but vulnerabilityCount > 0", () => {
      const notification = createScanNotification(10, 3, 0);
      expect(notification.level).toBe("warning");
      expect(notification.title).toContain("Security Vulnerabilities");
    });

    it("picks info when criticalCount === 0, vulnerabilityCount === 0, and outdatedCount > 0", () => {
      const notification = createScanNotification(4, 0, 0);
      expect(notification.level).toBe("info");
      expect(notification.title).toContain("Outdated");
    });

    it("picks success when all zero", () => {
      const notification = createScanNotification(0, 0, 0);
      expect(notification.level).toBe("success");
      expect(notification.title).toContain("All Clear");
    });
  });

  describe("createUpgradeNotification", () => {
    it("returns warning with 'Upgraded 3 packages, 1 failed.' for (3, 1, [])", () => {
      const notification = createUpgradeNotification(3, 1, []);
      expect(notification.level).toBe("warning");
      expect(notification.message).toBe("Upgraded 3 packages, 1 failed.");
    });

    it("returns success when failed is 0", () => {
      const notification = createUpgradeNotification(3, 0, []);
      expect(notification.level).toBe("success");
      expect(notification.message).toBe("Upgraded 3 packages.");
    });
  });
});
