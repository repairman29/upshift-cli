import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitAuditEvent } from "./audit-log.js";

describe("emitAuditEvent", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.UPSHIFT_AUDIT_URL;
    delete process.env.UPSHIFT_API_TOKEN;
    delete process.env.UPSHIFT_ORG;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is a no-op when UPSHIFT_AUDIT_URL is not set", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await emitAuditEvent("upgrade", "package", "react");
    expect(spy).not.toHaveBeenCalled();
  });

  it("POSTs to UPSHIFT_AUDIT_URL with correct shape", async () => {
    process.env.UPSHIFT_AUDIT_URL = "https://audit.example.com/events";

    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await emitAuditEvent("upgrade", "package", "react", { version: "19.0.0" });

    expect(spy).toHaveBeenCalledOnce();
    const [url, options] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://audit.example.com/events");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.event_type).toBe("upgrade");
    expect(body.resource_type).toBe("package");
    expect(body.resource_id).toBe("react");
    expect(body.metadata).toEqual({ version: "19.0.0" });
    expect(typeof body.timestamp).toBe("string");
  });

  it("includes Bearer token when UPSHIFT_API_TOKEN is set", async () => {
    process.env.UPSHIFT_AUDIT_URL = "https://audit.example.com/events";
    process.env.UPSHIFT_API_TOKEN = "my-token-123";

    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await emitAuditEvent("fix", "package", "lodash");

    const [, options] = spy.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-token-123");
  });

  it("includes org_id when UPSHIFT_ORG is set", async () => {
    process.env.UPSHIFT_AUDIT_URL = "https://audit.example.com/events";
    process.env.UPSHIFT_ORG = "550e8400-e29b-41d4-a716-446655440000";

    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await emitAuditEvent("scan_upload", "report", "report-123");

    const [, options] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.org_id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("does not throw when fetch fails (fire-and-forget)", async () => {
    process.env.UPSHIFT_AUDIT_URL = "https://audit.example.com/events";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    // Should not throw
    await expect(emitAuditEvent("upgrade", "package", "react")).resolves.toBeUndefined();
  });
});
