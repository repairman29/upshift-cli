import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import path from "path";
import os from "os";
import { clearConfigCache } from "./config.js";
import {
  detectPackageManager,
  getOutdatedPackages,
  runAudit,
  runAuditFix,
  getLockfileName,
  getInstallCommand,
  getAddCommand,
  runTests,
  PackageManager,
} from "./package-manager.js";
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

describe("detectPackageManager", () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
  });

  it("detects pnpm when all three lockfiles exist (precedence: pnpm > yarn > npm)", () => {
    writeFileSync(path.join(TMP, "pnpm-lock.yaml"), "");
    writeFileSync(path.join(TMP, "yarn.lock"), "");
    writeFileSync(path.join(TMP, "package-lock.json"), "");
    writeFileSync(path.join(TMP, "package.json"), "{}");
    expect(detectPackageManager(TMP)).toBe("pnpm");
  });

  it("detects yarn when yarn.lock and package-lock.json exist (precedence: yarn > npm)", () => {
    writeFileSync(path.join(TMP, "yarn.lock"), "");
    writeFileSync(path.join(TMP, "package-lock.json"), "");
    writeFileSync(path.join(TMP, "package.json"), "{}");
    expect(detectPackageManager(TMP)).toBe("yarn");
  });

  it("detects npm when package-lock.json exists without pnpm or yarn lockfiles", () => {
    writeFileSync(path.join(TMP, "package-lock.json"), "");
    writeFileSync(path.join(TMP, "package.json"), "{}");
    expect(detectPackageManager(TMP)).toBe("npm");
  });

  it("detects npm when only package.json exists", () => {
    writeFileSync(path.join(TMP, "package.json"), "{}");
    expect(detectPackageManager(TMP)).toBe("npm");
  });

  it("throws when directory has no package.json or lockfile", () => {
    expect(() => detectPackageManager(TMP)).toThrow(/No package\.json or lockfile/);
  });
});

describe("getOutdatedPackages", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockClear();
  });

  it("returns empty array when stdout is empty", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    const result = await getOutdatedPackages(TMP, "npm");
    expect(result).toEqual([]);
    expect(runCommand).toHaveBeenCalledWith("npm", ["outdated", "--json"], TMP, [0, 1]);
  });

  it("returns empty array when stdout is only whitespace", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: "   \n\t  ", stderr: "", exitCode: 0 });
    const result = await getOutdatedPackages(TMP, "yarn");
    expect(result).toEqual([]);
    expect(runCommand).toHaveBeenCalledWith("yarn", ["outdated", "--json"], TMP, [0, 1]);
  });

  it("maps npm JSON fields correctly and invokes runCommand with allowed exit codes [0, 1]", async () => {
    const fixture = JSON.stringify({
      react: {
        current: "18.2.0",
        wanted: "18.3.1",
        latest: "19.0.0",
        type: "dependencies",
      },
    });
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: fixture, stderr: "", exitCode: 1 });

    const result = await getOutdatedPackages(TMP, "npm");
    expect(runCommand).toHaveBeenCalledWith("npm", ["outdated", "--json"], TMP, [0, 1]);
    expect(result).toEqual([
      {
        name: "react",
        current: "18.2.0",
        wanted: "18.3.1",
        latest: "19.0.0",
        type: "dependencies",
      },
    ]);
  });

  it("parses yarn NDJSON table rows while skipping non-table lines and malformed lines", async () => {
    const ndjson = [
      JSON.stringify({ type: "info", data: "Colors are disabled" }),
      "not-valid-json-garbage-line",
      JSON.stringify({
        type: "table",
        data: {
          head: ["Package", "Current", "Wanted", "Latest", "Package Type", "URL"],
          body: [
            ["react", "18.2.0", "18.3.1", "19.0.0", "dependencies", "https://reactjs.org/"],
            ["lodash", "4.17.20", "4.17.21", "4.17.21", "devDependencies", "https://lodash.com/"],
          ],
        },
      }),
    ].join("\n");

    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: ndjson, stderr: "", exitCode: 0 });

    const result = await getOutdatedPackages(TMP, "yarn");
    expect(runCommand).toHaveBeenCalledWith("yarn", ["outdated", "--json"], TMP, [0, 1]);
    expect(result).toEqual([
      {
        name: "react",
        current: "18.2.0",
        wanted: "18.3.1",
        latest: "19.0.0",
        type: "dependencies",
      },
      {
        name: "lodash",
        current: "4.17.20",
        wanted: "4.17.21",
        latest: "4.17.21",
        type: "devDependencies",
      },
    ]);
  });

  it("maps pnpm JSON dependencyType to type and calls runCommand with allowed codes [0, 1]", async () => {
    const fixture = JSON.stringify({
      react: {
        current: "18.2.0",
        wanted: "18.3.1",
        latest: "19.0.0",
        dependencyType: "dependencies",
      },
      typescript: {
        current: "5.0.4",
        wanted: "5.1.0",
        latest: "5.5.0",
        dependencyType: "devDependencies",
      },
    });
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: fixture, stderr: "", exitCode: 0 });

    const result = await getOutdatedPackages(TMP, "pnpm");
    expect(runCommand).toHaveBeenCalledWith("pnpm", ["outdated", "--json"], TMP, [0, 1]);
    expect(result).toEqual([
      {
        name: "react",
        current: "18.2.0",
        wanted: "18.3.1",
        latest: "19.0.0",
        type: "dependencies",
      },
      {
        name: "typescript",
        current: "5.0.4",
        wanted: "5.1.0",
        latest: "5.5.0",
        type: "devDependencies",
      },
    ]);
  });
});

describe("runAudit", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockClear();
  });

  it("runs npm audit with allowed codes [0, 1, 2]", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: '{"vulnerabilities":{}}', stderr: "", exitCode: 1 });
    const result = await runAudit(TMP, "npm");
    expect(runCommand).toHaveBeenCalledWith("npm", ["audit", "--json"], TMP, [0, 1, 2]);
    expect(result).toEqual({ stdout: '{"vulnerabilities":{}}', exitCode: 1 });
  });

  it("runs yarn audit with allowed codes [0, 1, 2, 4, 8, 16]", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: '{"type":"auditAdvisory"}', stderr: "", exitCode: 4 });
    const result = await runAudit(TMP, "yarn");
    expect(runCommand).toHaveBeenCalledWith("yarn", ["audit", "--json"], TMP, [0, 1, 2, 4, 8, 16]);
    expect(result).toEqual({ stdout: '{"type":"auditAdvisory"}', exitCode: 4 });
  });

  it("runs pnpm audit with allowed codes [0, 1, 2]", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: '{"advisories":{}}', stderr: "", exitCode: 0 });
    const result = await runAudit(TMP, "pnpm");
    expect(runCommand).toHaveBeenCalledWith("pnpm", ["audit", "--json"], TMP, [0, 1, 2]);
    expect(result).toEqual({ stdout: '{"advisories":{}}', exitCode: 0 });
  });
});

describe("runAuditFix", () => {
  beforeEach(() => {
    vi.mocked(runCommand).mockClear();
  });

  it("calls npm audit fix for npm", async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 });
    await runAuditFix(TMP, "npm");
    expect(runCommand).toHaveBeenCalledWith("npm", ["audit", "fix"], TMP);
  });

  it("rejects for yarn with descriptive error", async () => {
    await expect(runAuditFix(TMP, "yarn")).rejects.toThrow("Yarn doesn't support audit fix. Run: npm audit fix");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects for pnpm with descriptive error", async () => {
    await expect(runAuditFix(TMP, "pnpm")).rejects.toThrow("pnpm doesn't support audit fix. Run: npm audit fix");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("package manager helper commands and lockfile names", () => {
  const table: Array<{
    pm: PackageManager;
    lockfile: string;
    installCmd: string;
    addCmdWithoutVersion: string;
    addCmdWithVersion: string;
  }> = [
    {
      pm: "npm",
      lockfile: "package-lock.json",
      installCmd: "npm install",
      addCmdWithoutVersion: "npm install react",
      addCmdWithVersion: "npm install react@^18.2.0",
    },
    {
      pm: "yarn",
      lockfile: "yarn.lock",
      installCmd: "yarn",
      addCmdWithoutVersion: "yarn add react",
      addCmdWithVersion: "yarn add react@^18.2.0",
    },
    {
      pm: "pnpm",
      lockfile: "pnpm-lock.yaml",
      installCmd: "pnpm install",
      addCmdWithoutVersion: "pnpm add react",
      addCmdWithVersion: "pnpm add react@^18.2.0",
    },
  ];

  it.each(table)(
    "returns expected lockfileName, installCommand, and addCommand for $pm",
    ({ pm, lockfile, installCmd, addCmdWithoutVersion, addCmdWithVersion }) => {
      expect(getLockfileName(pm)).toBe(lockfile);
      expect(getInstallCommand(pm)).toBe(installCmd);
      expect(getAddCommand(pm, "react")).toBe(addCmdWithoutVersion);
      expect(getAddCommand(pm, "react", "^18.2.0")).toBe(addCmdWithVersion);
    }
  );
});

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
