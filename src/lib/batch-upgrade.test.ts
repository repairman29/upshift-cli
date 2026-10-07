import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

// Mock modules before importing the module under test
vi.mock("./package-manager.js");
vi.mock("./config.js");

import { runBatchUpgrade } from "./batch-upgrade.js";
import * as packageManager from "./package-manager.js";
import * as config from "./config.js";

describe("batch-upgrade with auto-merge", () => {
  let testDir: string;

  beforeEach(() => {
    // Mock process.exit to prevent test from actually exiting
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    testDir = mkdtempSync(join(tmpdir(), "upshift-test-"));

    // Create a minimal package.json
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        version: "1.0.0",
        dependencies: {
          chalk: "4.0.0",
          semver: "7.0.0",
        },
        scripts: {
          test: "echo 'tests pass'",
        },
      })
    );

    // Create a minimal package-lock.json
    writeFileSync(
      join(testDir, "package-lock.json"),
      JSON.stringify({
        name: "test-project",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {},
      })
    );

    // Initialize git repo
    execSync("git init", { cwd: testDir });
    execSync('git config user.email "test@example.com"', { cwd: testDir });
    execSync('git config user.name "Test User"', { cwd: testDir });
    execSync("git add .", { cwd: testDir });
    execSync('git commit -m "Initial commit"', { cwd: testDir });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("should auto-merge each successful package upgrade as a separate commit", async () => {
    // Mock package manager functions
    vi.mocked(packageManager.detectPackageManager).mockReturnValue("npm");
    vi.mocked(packageManager.getLockfileName).mockReturnValue("package-lock.json");
    vi.mocked(packageManager.getOutdatedPackages).mockResolvedValue([
      { name: "chalk", current: "4.0.0", wanted: "4.1.2", latest: "4.1.2" },
      { name: "semver", current: "7.0.0", wanted: "7.6.3", latest: "7.6.3" },
    ]);

    // Mock installPackage to actually update package.json
    vi.mocked(packageManager.installPackage).mockImplementation(async (cwd, pkgName, version) => {
      const packageJsonPath = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      pkg.dependencies[pkgName] = version;
      writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
      // Also touch package-lock.json so git sees it as changed
      const lockPath = join(cwd, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.version = pkg.version;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    });

    vi.mocked(packageManager.runTests).mockResolvedValue(undefined);

    // Mock config functions
    vi.mocked(config.loadConfig).mockReturnValue({});
    vi.mocked(config.parseTestCommand).mockReturnValue(null);

    // Run batch upgrade with auto-merge
    await runBatchUpgrade({
      cwd: testDir,
      mode: "minor",
      yes: true,
      skipTests: false,
      autoMerge: true, // NEW FLAG
    });

    // Verify that we have 3 commits:
    // 1. Initial commit
    // 2. Upgrade chalk commit
    // 3. Upgrade semver commit
    const logOutput = execSync("git log --oneline", { cwd: testDir, encoding: "utf8" });
    const commits = logOutput.trim().split("\n");

    expect(commits.length).toBe(3);
    expect(commits[0]).toMatch(/upgrade: semver 7\.0\.0 → 7\.6\.3/);
    expect(commits[1]).toMatch(/upgrade: chalk 4\.0\.0 → 4\.1\.2/);
    expect(commits[2]).toMatch(/Initial commit/);
  });

  it("should rollback and skip a package when tests fail, but continue with others", async () => {
    // Mock package manager functions
    vi.mocked(packageManager.detectPackageManager).mockReturnValue("npm");
    vi.mocked(packageManager.getLockfileName).mockReturnValue("package-lock.json");
    vi.mocked(packageManager.getOutdatedPackages).mockResolvedValue([
      { name: "chalk", current: "4.0.0", wanted: "4.1.2", latest: "4.1.2" },
      { name: "semver", current: "7.0.0", wanted: "7.6.3", latest: "7.6.3" },
    ]);

    // Mock installPackage to actually update package.json
    vi.mocked(packageManager.installPackage).mockImplementation(async (cwd, pkgName, version) => {
      const packageJsonPath = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      pkg.dependencies[pkgName] = version;
      writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2));
      // Also touch package-lock.json so git sees it as changed
      const lockPath = join(cwd, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.version = pkg.version;
      writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    });

    // Mock config functions
    vi.mocked(config.loadConfig).mockReturnValue({});
    vi.mocked(config.parseTestCommand).mockReturnValue(null);

    // Mock tests: fail for chalk, pass for semver
    let testCallCount = 0;
    vi.mocked(packageManager.runTests).mockImplementation(async () => {
      testCallCount++;
      if (testCallCount === 1) {
        // First call (chalk) fails
        throw new Error("Tests failed");
      }
      // Second call (semver) passes
      return undefined;
    });

    await runBatchUpgrade({
      cwd: testDir,
      mode: "minor",
      yes: true,
      skipTests: false,
      autoMerge: true,
    });

    // Should have 2 commits: initial + semver (chalk rolled back)
    const logOutput = execSync("git log --oneline", { cwd: testDir, encoding: "utf8" });
    const commits = logOutput.trim().split("\n");

    expect(commits.length).toBe(2);
    expect(commits[0]).toMatch(/upgrade: semver 7\.0\.0 → 7\.6\.3/);
    expect(commits[1]).toMatch(/Initial commit/);

    // Verify chalk is still at old version in package.json
    const packageJson = JSON.parse(readFileSync(join(testDir, "package.json"), "utf8"));
    expect(packageJson.dependencies.chalk).toBe("4.0.0");
  });
});
