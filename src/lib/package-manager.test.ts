import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { clearConfigCache } from "./config.js";
import { runTests } from "./package-manager.js";
import { runCommand } from "./exec.js";

vi.mock("./exec.js", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

const TMP = path.join(os.tmpdir(), `upshift-pm-test-${Date.now()}`);

function setupProject(config?: object) {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "true" } }));
  if (config) {
    writeFileSync(path.join(TMP, ".upshiftrc.json"), JSON.stringify(config));
  }
}

describe("runTests", () => {
  beforeEach(() => {
    clearConfigCache();
    vi.mocked(runCommand).mockClear();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  });

  it("runs the configured testCommand string when set", async () => {
    setupProject({ testCommand: "npm run build" });
    await runTests(TMP, "npm");
    expect(runCommand).toHaveBeenCalledWith("npm", ["run", "build"], TMP);
  });

  it("runs the configured testCommand array when set", async () => {
    setupProject({ testCommand: ["node", "--test"] });
    await runTests(TMP, "npm");
    expect(runCommand).toHaveBeenCalledWith("node", ["--test"], TMP);
  });

  it("falls back to the package manager test script when testCommand is unset", async () => {
    setupProject();
    await runTests(TMP, "npm");
    expect(runCommand).toHaveBeenCalledWith("npm", ["test"], TMP);
  });

  it("uses the given package manager for the fallback", async () => {
    setupProject();
    await runTests(TMP, "yarn");
    expect(runCommand).toHaveBeenCalledWith("yarn", ["test"], TMP);
  });

  it("propagates failures from the configured testCommand", async () => {
    setupProject({ testCommand: "npm run build" });
    vi.mocked(runCommand).mockRejectedValueOnce(new Error("exit 1"));
    await expect(runTests(TMP, "npm")).rejects.toThrow("exit 1");
  });
});
