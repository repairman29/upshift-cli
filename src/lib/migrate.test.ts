import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listTemplates, findTemplate, loadTemplateFromFile, applyTemplate, type MigrationTemplate } from "./migrate.js";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import path from "path";
import os from "os";

describe("shipped migration templates", () => {
  it("loads every shipped migrations/*.json with package, non-empty steps, each step with id+description and either find+replace or package+version", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThan(0);

    for (const t of templates) {
      expect(t.package).toBeDefined();
      expect(typeof t.package).toBe("string");
      expect(t.package.length).toBeGreaterThan(0);

      expect(t.id).toBeDefined();
      expect(typeof t.id).toBe("string");
      expect(t.id?.length).toBeGreaterThan(0);

      expect(Array.isArray(t.steps)).toBe(true);
      expect(t.steps.length).toBeGreaterThan(0);

      for (const step of t.steps) {
        expect(step.id).toBeDefined();
        expect(typeof step.id).toBe("string");
        expect(step.description).toBeDefined();
        expect(typeof step.description).toBe("string");

        const hasFindReplace = step.find !== undefined && step.replace !== undefined;
        const hasPackageVersion = step.package !== undefined && step.version !== undefined;
        expect(hasFindReplace || hasPackageVersion).toBe(true);
      }
    }
  });

  it("resolves lookup by stem and by name; unknown id returns null", () => {
    // Test for react
    const byStemReact = findTemplate("react", "react-18-19");
    const byNameReact = findTemplate("react", "react-18-to-19");
    expect(byStemReact).not.toBeNull();
    expect(byNameReact).not.toBeNull();
    expect(byStemReact?.name).toBe("react-18-to-19");
    expect(byStemReact?.id).toBe("react-18-19");
    expect(byNameReact?.name).toBe("react-18-to-19");

    // Test for next
    const byStemNext = findTemplate("next", "next-13-14");
    const byNameNext = findTemplate("next", "next-13-to-14");
    expect(byStemNext).not.toBeNull();
    expect(byNameNext).not.toBeNull();
    expect(byStemNext?.id).toBe("next-13-14");
    expect(byNameNext?.name).toBe("next-13-to-14");

    // Unknown id returns null
    expect(findTemplate("react", "nope")).toBeNull();
    expect(findTemplate("unknown-pkg", "react-18-19")).toBeNull();
  });
});

describe("loadTemplateFromFile", () => {
  const tmpDir = path.join(os.tmpdir(), `upshift-load-template-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing file", () => {
    const res = loadTemplateFromFile(path.join(tmpDir, "missing.json"));
    expect(res).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const invalidPath = path.join(tmpDir, "invalid.json");
    writeFileSync(invalidPath, "{ broken json ...", "utf8");
    const res = loadTemplateFromFile(invalidPath);
    expect(res).toBeNull();
  });

  it("returns null for JSON missing package or steps", () => {
    const missingPkgPath = path.join(tmpDir, "missing-pkg.json");
    writeFileSync(missingPkgPath, JSON.stringify({ steps: [] }), "utf8");
    expect(loadTemplateFromFile(missingPkgPath)).toBeNull();

    const missingStepsPath = path.join(tmpDir, "missing-steps.json");
    writeFileSync(missingStepsPath, JSON.stringify({ package: "foo" }), "utf8");
    expect(loadTemplateFromFile(missingStepsPath)).toBeNull();

    const invalidStepsPath = path.join(tmpDir, "invalid-steps.json");
    writeFileSync(invalidStepsPath, JSON.stringify({ package: "foo", steps: "not-an-array" }), "utf8");
    expect(loadTemplateFromFile(invalidStepsPath)).toBeNull();
  });

  it("loads a valid custom template JSON and sets id and name from filename stem if missing", () => {
    const validPath = path.join(tmpDir, "custom-mod.json");
    writeFileSync(
      validPath,
      JSON.stringify({
        package: "custom-pkg",
        steps: [{ id: "step-1", description: "test step", find: "a", replace: "b" }],
      }),
      "utf8"
    );
    const res = loadTemplateFromFile(validPath);
    expect(res).not.toBeNull();
    expect(res?.id).toBe("custom-mod");
    expect(res?.name).toBe("custom-mod");
    expect(res?.package).toBe("custom-pkg");
    expect(res?.steps.length).toBe(1);
  });
});

describe("applyTemplate", () => {
  const tmpDir = path.join(os.tmpdir(), `upshift-apply-template-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("replaces all occurrences across multiple files, reports occurrences/filesModified, skips node_modules/, .git/, dist/, and with dryRun: true writes nothing", () => {
    // Setup nested files
    const file1 = path.join(tmpDir, "src", "index.ts");
    const file2 = path.join(tmpDir, "src", "utils.tsx");
    const nodeModulesFile = path.join(tmpDir, "node_modules", "pkg", "index.js");
    const gitFile = path.join(tmpDir, ".git", "hooks", "hook.js");
    const distFile = path.join(tmpDir, "dist", "bundle.js");

    mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    mkdirSync(path.join(tmpDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    mkdirSync(path.join(tmpDir, "dist"), { recursive: true });

    const initialContent1 = "foo bar foo baz\nfoo";
    const initialContent2 = "const x = foo;";
    const initialIgnored = "foo should not change";

    writeFileSync(file1, initialContent1, "utf8");
    writeFileSync(file2, initialContent2, "utf8");
    writeFileSync(nodeModulesFile, initialIgnored, "utf8");
    writeFileSync(gitFile, initialIgnored, "utf8");
    writeFileSync(distFile, initialIgnored, "utf8");

    const template: MigrationTemplate = {
      name: "test-template",
      description: "Test template description",
      from: "1.0",
      to: "2.0",
      package: "test-pkg",
      steps: [
        {
          id: "replace-foo",
          description: "Replace foo with bar",
          find: "foo",
          replace: "bar",
        },
        {
          id: "bump-dep",
          description: "Bump test-dep",
          package: "test-dep",
          version: "^2.0.0",
        },
      ],
    };

    // 1. Dry run
    const dryRunResult = applyTemplate({
      cwd: tmpDir,
      template,
      dryRun: true,
    });

    expect(dryRunResult.totalOccurrences).toBe(4); // 3 in file1, 1 in file2
    expect(dryRunResult.filesModified).toHaveLength(2);
    expect(dryRunResult.packageSteps).toEqual([{ package: "test-dep", version: "^2.0.0" }]);
    expect(dryRunResult.stepsApplied).toBe(2);

    // Verify files were NOT changed under dryRun
    expect(readFileSync(file1, "utf8")).toBe(initialContent1);
    expect(readFileSync(file2, "utf8")).toBe(initialContent2);
    expect(readFileSync(nodeModulesFile, "utf8")).toBe(initialIgnored);
    expect(readFileSync(gitFile, "utf8")).toBe(initialIgnored);
    expect(readFileSync(distFile, "utf8")).toBe(initialIgnored);

    // 2. Real run
    const realResult = applyTemplate({
      cwd: tmpDir,
      template,
      dryRun: false,
    });

    expect(realResult.totalOccurrences).toBe(4);
    expect(realResult.filesModified).toHaveLength(2);
    expect(realResult.stepsApplied).toBe(2);

    // Verify files WERE changed
    expect(readFileSync(file1, "utf8")).toBe("bar bar bar baz\nbar");
    expect(readFileSync(file2, "utf8")).toBe("const x = bar;");

    // Verify ignored directories were skipped
    expect(readFileSync(nodeModulesFile, "utf8")).toBe(initialIgnored);
    expect(readFileSync(gitFile, "utf8")).toBe(initialIgnored);
    expect(readFileSync(distFile, "utf8")).toBe(initialIgnored);
  });
});
