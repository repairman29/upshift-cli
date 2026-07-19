import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, clearConfigCache, shouldIgnorePackage, createConfigTemplate, parseTestCommand } from "./config.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import path from "path";
import os from "os";

const TMP = path.join(os.tmpdir(), `upshift-config-test-${Date.now()}`);

function writeConfig(obj: object) {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(path.join(TMP, ".upshiftrc.json"), JSON.stringify(obj));
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
