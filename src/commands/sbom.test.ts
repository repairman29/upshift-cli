import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("sbom command", () => {
  let tmpDir: string;
  let cliPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-test-"));
    cliPath = path.join(process.cwd(), "dist", "cli.js");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes VCS external reference when repository field is present", () => {
    // Create a minimal package.json with repository info
    const pkgJson = {
      name: "test-package",
      version: "1.0.0",
      repository: {
        type: "git",
        url: "git+https://github.com/example/test-repo.git",
      },
      dependencies: {
        chalk: "^5.3.0",
      },
    };

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    // Create a fake node_modules/chalk/package.json with repository
    const chalkDir = path.join(tmpDir, "node_modules", "chalk");
    fs.mkdirSync(chalkDir, { recursive: true });
    fs.writeFileSync(
      path.join(chalkDir, "package.json"),
      JSON.stringify({
        name: "chalk",
        version: "5.3.0",
        repository: {
          type: "git",
          url: "https://github.com/chalk/chalk.git",
        },
      })
    );

    // Run the SBOM command with --json output
    const result = execSync(`node "${cliPath}" sbom --cwd "${tmpDir}" --json`, {
      encoding: "utf8",
    });

    const sbom = JSON.parse(result);

    // Verify the SBOM structure
    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.components).toBeDefined();
    expect(Array.isArray(sbom.components)).toBe(true);

    // Find the chalk component
    const chalkComponent = sbom.components.find((c: any) => c.name === "chalk");
    expect(chalkComponent).toBeDefined();

    // CRITICAL: Verify that externalReferences includes VCS type
    expect(chalkComponent.externalReferences).toBeDefined();
    expect(Array.isArray(chalkComponent.externalReferences)).toBe(true);

    const vcsRef = chalkComponent.externalReferences.find((ref: any) => ref.type === "vcs");
    expect(vcsRef).toBeDefined();
    expect(vcsRef.url).toBe("https://github.com/chalk/chalk.git");

    // Should still have the website reference too
    const websiteRef = chalkComponent.externalReferences.find((ref: any) => ref.type === "website");
    expect(websiteRef).toBeDefined();
    expect(websiteRef.url).toBe("https://www.npmjs.com/package/chalk");
  });

  it("includes issue-tracker external reference when bugs field is present", () => {
    const pkgJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "test-dep": "^1.0.0",
      },
    };

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    const depDir = path.join(tmpDir, "node_modules", "test-dep");
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(
      path.join(depDir, "package.json"),
      JSON.stringify({
        name: "test-dep",
        version: "1.0.0",
        bugs: {
          url: "https://github.com/example/test-dep/issues",
        },
      })
    );

    const result = execSync(`node "${cliPath}" sbom --cwd "${tmpDir}" --json`, {
      encoding: "utf8",
    });

    const sbom = JSON.parse(result);
    const component = sbom.components.find((c: any) => c.name === "test-dep");

    expect(component).toBeDefined();
    expect(component.externalReferences).toBeDefined();

    const issueTrackerRef = component.externalReferences.find((ref: any) => ref.type === "issue-tracker");
    expect(issueTrackerRef).toBeDefined();
    expect(issueTrackerRef.url).toBe("https://github.com/example/test-dep/issues");
  });

  it("handles packages without repository information gracefully", () => {
    const pkgJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "no-repo-pkg": "^1.0.0",
      },
    };

    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));

    const depDir = path.join(tmpDir, "node_modules", "no-repo-pkg");
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(
      path.join(depDir, "package.json"),
      JSON.stringify({
        name: "no-repo-pkg",
        version: "1.0.0",
        // No repository or bugs field
      })
    );

    const result = execSync(`node "${cliPath}" sbom --cwd "${tmpDir}" --json`, {
      encoding: "utf8",
    });

    const sbom = JSON.parse(result);
    const component = sbom.components.find((c: any) => c.name === "no-repo-pkg");

    expect(component).toBeDefined();
    expect(component.externalReferences).toBeDefined();

    // Should still have website reference
    const websiteRef = component.externalReferences.find((ref: any) => ref.type === "website");
    expect(websiteRef).toBeDefined();

    // Should not have VCS or issue-tracker references
    const vcsRef = component.externalReferences.find((ref: any) => ref.type === "vcs");
    expect(vcsRef).toBeUndefined();
  });
});
