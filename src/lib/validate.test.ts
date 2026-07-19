import { describe, it, expect, vi } from "vitest";
import {
  packageNameSchema,
  versionSchema,
  fsPathSchema,
  webhookUrlSchema,
  orgIdSchema,
  validateOrExit,
} from "./validate.js";

describe("packageNameSchema", () => {
  it("accepts valid npm names", () => {
    expect(packageNameSchema.safeParse("react").success).toBe(true);
    expect(packageNameSchema.safeParse("@types/node").success).toBe(true);
    expect(packageNameSchema.safeParse("lodash-es").success).toBe(true);
    expect(packageNameSchema.safeParse("ts-morph").success).toBe(true);
    expect(packageNameSchema.safeParse("@scope/package-name").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(packageNameSchema.safeParse("").success).toBe(false);
  });

  it("rejects names longer than 214 chars", () => {
    expect(packageNameSchema.safeParse("a".repeat(215)).success).toBe(false);
  });

  it("rejects names with spaces or special chars", () => {
    expect(packageNameSchema.safeParse("my package").success).toBe(false);
    expect(packageNameSchema.safeParse("../../../etc/passwd").success).toBe(false);
    expect(packageNameSchema.safeParse("pkg; rm -rf /").success).toBe(false);
  });
});

describe("versionSchema", () => {
  it("accepts valid semver strings", () => {
    expect(versionSchema.safeParse("1.0.0").success).toBe(true);
    expect(versionSchema.safeParse("18.3.0-alpha.1").success).toBe(true);
    expect(versionSchema.safeParse("latest").success).toBe(true);
    expect(versionSchema.safeParse("next").success).toBe(true);
    expect(versionSchema.safeParse("beta").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(versionSchema.safeParse("").success).toBe(false);
  });

  it("rejects version ranges and shell metacharacters", () => {
    expect(versionSchema.safeParse(">=1.0.0").success).toBe(false);
    expect(versionSchema.safeParse("^1.0.0").success).toBe(false);
    expect(versionSchema.safeParse("~1.0.0").success).toBe(false);
    expect(versionSchema.safeParse("1.0.0; rm -rf").success).toBe(false);
  });
});

describe("fsPathSchema", () => {
  it("accepts normal paths", () => {
    expect(fsPathSchema.safeParse("/home/user/project").success).toBe(true);
    expect(fsPathSchema.safeParse("./relative/path").success).toBe(true);
    expect(fsPathSchema.safeParse("C:\\Users\\project").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(fsPathSchema.safeParse("").success).toBe(false);
  });

  it("rejects paths with null bytes", () => {
    expect(fsPathSchema.safeParse("/path/\0file").success).toBe(false);
  });
});

describe("webhookUrlSchema", () => {
  it("accepts valid https URLs", () => {
    expect(webhookUrlSchema.safeParse("https://hooks.slack.com/services/abc123").success).toBe(true);
    expect(webhookUrlSchema.safeParse("http://localhost:3000/webhook").success).toBe(true);
  });

  it("rejects non-URLs", () => {
    expect(webhookUrlSchema.safeParse("not-a-url").success).toBe(false);
    expect(webhookUrlSchema.safeParse("ftp://example.com").success).toBe(false);
    expect(webhookUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
  });
});

describe("orgIdSchema", () => {
  it("accepts valid UUIDs", () => {
    expect(orgIdSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
  });

  it("rejects non-UUIDs", () => {
    expect(orgIdSchema.safeParse("my-org").success).toBe(false);
    expect(orgIdSchema.safeParse("").success).toBe(false);
  });
});

describe("validateOrExit", () => {
  it("returns parsed value on success", () => {
    const result = validateOrExit(packageNameSchema, "react");
    expect(result).toBe("react");
  });

  it("calls process.exit(1) on failure", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    expect(() => validateOrExit(packageNameSchema, "")).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
