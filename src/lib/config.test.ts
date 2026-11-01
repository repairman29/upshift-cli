import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadConfig,
  clearConfigCache,
  shouldIgnorePackage,
  createConfigTemplate,
  parseTestCommand,
  type UpshiftConfig,
} from "./config.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import path from "path";
import os from "os";

const TMP = path.join(os.tmpdir(), `upshift-config-test-${Date.now()}`);

function writeConfig(obj: object, dir: string = TMP, filename: string = ".upshiftrc.json") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), JSON.stringify(obj));
}

describe("loadConfig", () => {
  beforeEach(() => {
    clearConfigCache();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig(TMP);
    expect(config.defaultMode).toBe("minor");
    expect(config.autoTest).toBe(true);
    expect(config.autoConfirm).toBe(false);
    expect(Array.isArray(config.ignore)).toBe(true);
  });

  it("merges user config with defaults", () => {
    writeConfig({ defaultMode: "all", autoConfirm: true });
    const config = loadConfig(TMP);
    expect(config.defaultMode).toBe("all");
    expect(config.autoConfirm).toBe(true);
    // Default preserved
    expect(config.autoTest).toBe(true);
  });

  it("ignores packages matching exact names", () => {
    writeConfig({ ignore: ["lodash", "moment"] });
    const config = loadConfig(TMP);
    expect(shouldIgnorePackage(config, "lodash")).toBe(true);
    expect(shouldIgnorePackage(config, "moment")).toBe(true);
    expect(shouldIgnorePackage(config, "react")).toBe(false);
  });

  it("ignores packages matching glob patterns", () => {
    writeConfig({ ignore: ["@types/*"] });
    const config = loadConfig(TMP);
    expect(shouldIgnorePackage(config, "@types/node")).toBe(true);
    expect(shouldIgnorePackage(config, "@types/react")).toBe(true);
    expect(shouldIgnorePackage(config, "react")).toBe(false);
  });

  it("returns empty ignore list by default", () => {
    const config = loadConfig(TMP);
    expect(shouldIgnorePackage(config, "react")).toBe(false);
  });

  it("merges ai and scan sub-objects", () => {
    writeConfig({ ai: { autoEnable: true }, scan: { minSeverity: "high" } });
    const config = loadConfig(TMP);
    expect(config.ai?.autoEnable).toBe(true);
    expect(config.ai?.maxCredits).toBe(50); // default preserved
    expect(config.scan?.minSeverity).toBe("high");
    expect(config.scan?.exclude).toEqual([]); // default preserved
  });

  it("caches config after first load", () => {
    writeConfig({ defaultMode: "patch" });
    const first = loadConfig(TMP);
    // Overwrite the file — cache should ignore it
    writeConfig({ defaultMode: "all" });
    const second = loadConfig(TMP);
    expect(first).toBe(second); // same object reference
  });

  it("clearConfigCache resets the cache", () => {
    writeConfig({ defaultMode: "patch" });
    loadConfig(TMP);
    clearConfigCache();
    writeConfig({ defaultMode: "all" });
    const config = loadConfig(TMP);
    expect(config.defaultMode).toBe("all");
  });

  it("caches config per cwd and returns different configs for different directories", () => {
    const dirA = path.join(TMP, "dir-a");
    const dirB = path.join(TMP, "dir-b");
    writeConfig({ defaultMode: "patch" }, dirA);
    writeConfig({ defaultMode: "all" }, dirB);

    const configA = loadConfig(dirA);
    const configB = loadConfig(dirB);

    expect(configA.defaultMode).toBe("patch");
    expect(configB.defaultMode).toBe("all");
    expect(configA).not.toBe(configB);

    // Verify clearConfigCache clears both
    clearConfigCache();
    writeConfig({ defaultMode: "minor" }, dirA);
    writeConfig({ defaultMode: "minor" }, dirB);
    expect(loadConfig(dirA).defaultMode).toBe("minor");
    expect(loadConfig(dirB).defaultMode).toBe("minor");
  });

  it("observes file precedence: .upshiftrc.json > .upshiftrc > upshift.config.json", () => {
    // Write all three files with different values
    writeConfig({ defaultMode: "all" }, TMP, ".upshiftrc.json");
    writeConfig({ defaultMode: "minor" }, TMP, ".upshiftrc");
    writeConfig({ defaultMode: "patch" }, TMP, "upshift.config.json");

    expect(loadConfig(TMP).defaultMode).toBe("all");

    // Remove .upshiftrc.json; .upshiftrc should take precedence over upshift.config.json
    clearConfigCache();
    rmSync(path.join(TMP, ".upshiftrc.json"));
    expect(loadConfig(TMP).defaultMode).toBe("minor");

    // Remove .upshiftrc; upshift.config.json should be used
    clearConfigCache();
    rmSync(path.join(TMP, ".upshiftrc"));
    expect(loadConfig(TMP).defaultMode).toBe("patch");
  });

  it("falls through to next config file when higher precedence file is malformed and warns once", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(TMP, { recursive: true });
    // Malformed .upshiftrc.json
    writeFileSync(path.join(TMP, ".upshiftrc.json"), "{ invalid json ");
    // Valid fallback upshift.config.json
    writeConfig({ defaultMode: "all" }, TMP, "upshift.config.json");

    const config = loadConfig(TMP);
    expect(config.defaultMode).toBe("all");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to parse .upshiftrc.json"));
    warnSpy.mockRestore();
  });

  it("returns default config and warns when only malformed config file exists", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(TMP, { recursive: true });
    writeFileSync(path.join(TMP, ".upshiftrc.json"), "{ not json ");

    const config = loadConfig(TMP);
    expect(config.defaultMode).toBe("minor");
    expect(config.autoTest).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to parse .upshiftrc.json"));
    warnSpy.mockRestore();
  });

  it("merges approval nested object preserving defaults", () => {
    writeConfig({
      approval: {
        webhookUrl: "https://example.com/webhook",
      },
    });
    const config = loadConfig(TMP);
    expect(config.approval?.mode).toBe("prompt");
    expect(config.approval?.requireFor).toEqual(["major"]);
    expect(config.approval?.webhookUrl).toBe("https://example.com/webhook");
  });

  it("merges upgradePolicy.blockRisk and registry nested objects", () => {
    writeConfig({
      upgradePolicy: {
        blockRisk: ["high"],
      },
      registry: {
        url: "https://custom.registry.org",
        token: "$CUSTOM_TOKEN",
      },
    });
    const config = loadConfig(TMP);
    expect(config.upgradePolicy?.blockRisk).toEqual(["high"]);
    expect(config.registry?.url).toBe("https://custom.registry.org");
    expect(config.registry?.token).toBe("$CUSTOM_TOKEN");
  });

  it("passes through unknown defaultMode string unchanged", () => {
    writeConfig({
      defaultMode: "custom-mode" as unknown as UpshiftConfig["defaultMode"],
    });
    const config = loadConfig(TMP);
    expect(config.defaultMode).toBe("custom-mode");
  });
});

describe("parseTestCommand", () => {
  it("returns null when unset", () => {
    expect(parseTestCommand(undefined)).toBeNull();
  });

  it("splits a string command on whitespace", () => {
    expect(parseTestCommand("poetry run pytest")).toEqual(["poetry", "run", "pytest"]);
    expect(parseTestCommand("  npm  run   build ")).toEqual(["npm", "run", "build"]);
  });

  it("returns an array command as-is", () => {
    expect(parseTestCommand(["bundle", "exec", "rspec"])).toEqual(["bundle", "exec", "rspec"]);
  });

  it("returns null for empty values", () => {
    expect(parseTestCommand("")).toBeNull();
    expect(parseTestCommand("   ")).toBeNull();
    expect(parseTestCommand([])).toBeNull();
  });
});

describe("loadConfig testCommand", () => {
  beforeEach(() => {
    clearConfigCache();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  it("reads testCommand from .upshiftrc.json", () => {
    writeConfig({ testCommand: "npm run build" });
    const config = loadConfig(TMP);
    expect(config.testCommand).toBe("npm run build");
    expect(parseTestCommand(config.testCommand)).toEqual(["npm", "run", "build"]);
  });

  it("leaves testCommand unset by default", () => {
    const config = loadConfig(TMP);
    expect(config.testCommand).toBeUndefined();
  });
});

describe("createConfigTemplate", () => {
  it("returns valid JSON", () => {
    const tpl = createConfigTemplate();
    expect(() => JSON.parse(tpl)).not.toThrow();
  });

  it("includes $schema field", () => {
    const parsed = JSON.parse(createConfigTemplate());
    expect(parsed.$schema).toContain("upshiftai.dev");
  });
});
