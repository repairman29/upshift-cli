import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

const creditsFile = path.join(os.homedir(), ".upshift", "credits.json");

function cleanCreditsFile() {
  if (existsSync(creditsFile)) {
    try {
      unlinkSync(creditsFile);
    } catch {
      /* ignore */
    }
  }
}

describe("credits module (local file)", () => {
  beforeEach(() => {
    // Remove cached module state between tests
    vi.resetModules();
    cleanCreditsFile();
    // Remove env vars that route to remote
    delete process.env.UPSHIFT_CREDITS_ENDPOINT;
    delete process.env.UPSHIFT_API_TOKEN;
    delete process.env.UPSHIFT_ORG;
    delete process.env.UPSHIFT_CREDITS;
  });

  afterEach(() => {
    cleanCreditsFile();
  });

  it("starts with 10 free credits", async () => {
    const { getCreditBalance } = await import("./credits.js");
    expect(getCreditBalance()).toBe(10);
  });

  it("addCredits increases balance", async () => {
    const { getCreditBalance, addCredits } = await import("./credits.js");
    addCredits(5);
    expect(getCreditBalance()).toBe(15);
  });

  it("resetCredits sets exact balance", async () => {
    const { getCreditBalance, resetCredits } = await import("./credits.js");
    resetCredits(100);
    expect(getCreditBalance()).toBe(100);
  });

  it("consumeCredit reduces balance by 1", async () => {
    const { getCreditBalance, consumeCredit } = await import("./credits.js");
    await consumeCredit("explain_ai");
    expect(getCreditBalance()).toBe(9);
  });

  it("consumeCredit reduces balance by custom count", async () => {
    const { getCreditBalance, consumeCredit } = await import("./credits.js");
    await consumeCredit("fix", 3);
    expect(getCreditBalance()).toBe(7);
  });

  it("consumeCredit calls process.exit(2) when balance insufficient", async () => {
    const { resetCredits, consumeCredit } = await import("./credits.js");
    resetCredits(0);

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as never;

    try {
      await consumeCredit("fix", 3);
    } catch {
      // expected
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBe(2);
  });

  it("UPSHIFT_CREDITS env sets initial balance", async () => {
    process.env.UPSHIFT_CREDITS = "50";
    const { getCreditBalance } = await import("./credits.js");
    expect(getCreditBalance()).toBe(50);
    delete process.env.UPSHIFT_CREDITS;
  });
});

describe("credits module (org remote path)", () => {
  beforeEach(() => {
    vi.resetModules();
    cleanCreditsFile();
  });

  afterEach(() => {
    cleanCreditsFile();
    delete process.env.UPSHIFT_CREDITS_ENDPOINT;
    delete process.env.UPSHIFT_API_TOKEN;
    delete process.env.UPSHIFT_ORG;
    vi.restoreAllMocks();
  });

  it("calls /credits/consume-org when UPSHIFT_ORG is set", async () => {
    process.env.UPSHIFT_CREDITS_ENDPOINT = "http://localhost:9999";
    process.env.UPSHIFT_API_TOKEN = "test-token";
    process.env.UPSHIFT_ORG = "550e8400-e29b-41d4-a716-446655440000";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ balance: 99 }), { status: 200 }));

    const { consumeCredit } = await import("./credits.js");
    await consumeCredit("fix", 3);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callUrl = fetchSpy.mock.calls[0][0] as string;
    expect(callUrl).toContain("/credits/consume-org");

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.org_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(body.count).toBe(3);
    expect(body.action).toBe("fix");
  });

  it("falls back to per-user consume when org endpoint returns non-ok", async () => {
    process.env.UPSHIFT_CREDITS_ENDPOINT = "http://localhost:9999";
    process.env.UPSHIFT_API_TOKEN = "test-token";
    process.env.UPSHIFT_ORG = "550e8400-e29b-41d4-a716-446655440000";

    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      callCount++;
      if (String(url).includes("/credits/consume-org")) {
        return new Response(JSON.stringify({ error: "supabase_not_configured" }), { status: 503 });
      }
      return new Response(JSON.stringify({ balance: 9 }), { status: 200 });
    });

    const { consumeCredit } = await import("./credits.js");
    await consumeCredit("explain_ai");

    // Should have tried org endpoint first, then per-user endpoint
    expect(callCount).toBe(2);
  });
});
