import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { runRollback, listBackups } from "./rollback.js";
import { runCommand } from "./exec.js";
import { confirm, select } from "@inquirer/prompts";

vi.mock("./exec.js", () => ({
  runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
}));

const TMP = path.join(os.tmpdir(), `upshift-rollback-test-${Date.now()}`);

describe("rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("runRollback({cwd, yes: true}) restores the newest stamp package.json bytes and calls npm for package-lock.json", async () => {
    const backupDir = path.join(TMP, ".upshift", "backups", "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), JSON.stringify({ name: "restored-npm", version: "1.0.0" }));
    writeFileSync(path.join(backupDir, "package-lock.json"), "{}");

    // Existing cwd state
    writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "old-state" }));

    await runRollback({ cwd: TMP, yes: true });

    const restoredPkg = JSON.parse(readFileSync(path.join(TMP, "package.json"), "utf8"));
    expect(restoredPkg.name).toBe("restored-npm");
    expect(existsSync(path.join(TMP, "package-lock.json"))).toBe(true);
    expect(runCommand).toHaveBeenCalledWith("npm", ["install"], TMP);
  });

  it("runRollback({cwd, yes: true}) restores yarn.lock and calls yarn install", async () => {
    const backupDir = path.join(TMP, ".upshift", "backups", "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), JSON.stringify({ name: "restored-yarn", version: "1.0.0" }));
    writeFileSync(path.join(backupDir, "yarn.lock"), "# yarn lockfile v1");

    writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "old-state" }));

    await runRollback({ cwd: TMP, yes: true });

    const restoredPkg = JSON.parse(readFileSync(path.join(TMP, "package.json"), "utf8"));
    expect(restoredPkg.name).toBe("restored-yarn");
    expect(readFileSync(path.join(TMP, "yarn.lock"), "utf8")).toBe("# yarn lockfile v1");
    expect(runCommand).toHaveBeenCalledWith("yarn", ["install"], TMP);
  });

  it("runRollback({cwd, yes: true}) restores pnpm-lock.yaml and calls pnpm install", async () => {
    const backupDir = path.join(TMP, ".upshift", "backups", "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), JSON.stringify({ name: "restored-pnpm", version: "1.0.0" }));
    writeFileSync(path.join(backupDir, "pnpm-lock.yaml"), "lockfileVersion: 5.4");

    writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "old-state" }));

    await runRollback({ cwd: TMP, yes: true });

    const restoredPkg = JSON.parse(readFileSync(path.join(TMP, "package.json"), "utf8"));
    expect(restoredPkg.name).toBe("restored-pnpm");
    expect(readFileSync(path.join(TMP, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: 5.4");
    expect(runCommand).toHaveBeenCalledWith("pnpm", ["install"], TMP);
  });

  it("chooses the lexically latest stamp when two stamps exist", async () => {
    const backupDir1 = path.join(TMP, ".upshift", "backups", "2024-01-15T10-00-00-000Z");
    const backupDir2 = path.join(TMP, ".upshift", "backups", "2024-01-15T12-00-00-000Z");
    mkdirSync(backupDir1, { recursive: true });
    mkdirSync(backupDir2, { recursive: true });

    writeFileSync(path.join(backupDir1, "package.json"), JSON.stringify({ name: "older-backup" }));
    writeFileSync(path.join(backupDir1, "package-lock.json"), "{}");

    writeFileSync(path.join(backupDir2, "package.json"), JSON.stringify({ name: "newer-backup" }));
    writeFileSync(path.join(backupDir2, "package-lock.json"), "{}");

    writeFileSync(path.join(TMP, "package.json"), JSON.stringify({ name: "current" }));

    await runRollback({ cwd: TMP, yes: true });

    const restoredPkg = JSON.parse(readFileSync(path.join(TMP, "package.json"), "utf8"));
    expect(restoredPkg.name).toBe("newer-backup");
    expect(runCommand).toHaveBeenCalledWith("npm", ["install"], TMP);
  });

  it("handles missing backups dir with 'No backups found.' and no runCommand", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runRollback({ cwd: TMP, yes: true });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No backups found."));
    expect(runCommand).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("handles empty backups dir with 'No backups found.' and no runCommand", async () => {
    mkdirSync(path.join(TMP, ".upshift", "backups"), { recursive: true });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runRollback({ cwd: TMP, yes: true });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("No backups found."));
    expect(runCommand).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("exits 1 in non-TTY environment without --yes", async () => {
    const backupDir = path.join(TMP, ".upshift", "backups", "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), "{}");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const origIsTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;

    try {
      await expect(runRollback({ cwd: TMP })).rejects.toThrow("process.exit called");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = origIsTTY;
      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it("removes backups dir when all: true and confirm is true", async () => {
    const backupRoot = path.join(TMP, ".upshift", "backups");
    const backupDir = path.join(backupRoot, "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), "{}");

    vi.mocked(confirm).mockResolvedValueOnce(true);

    await runRollback({ cwd: TMP, all: true });

    expect(confirm).toHaveBeenCalled();
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("keeps backups dir when all: true and confirm is false", async () => {
    const backupRoot = path.join(TMP, ".upshift", "backups");
    const backupDir = path.join(backupRoot, "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), "{}");

    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runRollback({ cwd: TMP, all: true });

    expect(confirm).toHaveBeenCalled();
    expect(existsSync(backupRoot)).toBe(true);
  });

  it("restores selected backup when interactive: true", async () => {
    const backupDir = path.join(TMP, ".upshift", "backups", "2024-01-15T10-30-00-000Z");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), JSON.stringify({ name: "interactive-restored" }));
    writeFileSync(path.join(backupDir, "package-lock.json"), "{}");

    vi.mocked(select).mockResolvedValueOnce(0);

    await runRollback({ cwd: TMP, interactive: true });

    expect(select).toHaveBeenCalled();
    const restoredPkg = JSON.parse(readFileSync(path.join(TMP, "package.json"), "utf8"));
    expect(restoredPkg.name).toBe("interactive-restored");
    expect(runCommand).toHaveBeenCalledWith("npm", ["install"], TMP);
  });

  it("listBackups output includes the stamp path", async () => {
    const stamp = "2024-01-15T10-30-00-000Z";
    const backupDir = path.join(TMP, ".upshift", "backups", stamp);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(path.join(backupDir, "package.json"), "{}");

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await listBackups(TMP);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(backupDir));
    consoleSpy.mockRestore();
  });
});
