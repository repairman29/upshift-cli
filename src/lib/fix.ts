import chalk from "chalk";
import ora from "ora";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { glob } from "glob";
import { createTwoFilesPatch } from "diff";
import { consumeCredit } from "./credits.js";
import { emitAuditEvent } from "./audit-log.js";
import { type ASTTransform, canHandleWithAST, applyASTTransform } from "./codemod.js";

export type FixOptions = {
  cwd: string;
  packageName: string;
  fromVersion?: string;
  toVersion?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** ast = AST-only, regex = regex/literal-only, auto = AST first, regex fallback */
  mode?: "ast" | "regex" | "auto";
};

export type CodeFix = {
  file: string;
  line: number;
  original: string;
  replacement: string;
  description: string;
  /** How this fix was produced */
  mode: "ast" | "regex" | "literal";
};

/**
 * high      = AST transform + tests passed
 * medium    = AST transform, tests not run (or AST + tests skipped)
 * heuristic = regex/literal replacement, review recommended
 */
export type FixConfidence = "high" | "medium" | "heuristic";

export type FixResult = {
  package: string;
  fromVersion: string | null;
  toVersion: string;
  fixes: CodeFix[];
  applied: boolean;
  confidence?: FixConfidence;
  astFixCount?: number;
  regexFixCount?: number;
};

export async function runFix(options: FixOptions): Promise<void> {
  await consumeCredit("fix", 3);

  const mode = options.mode ?? "auto";
  const spinner = ora(`Analyzing ${options.packageName} upgrade...`).start();

  try {
    const currentVersion = options.fromVersion ?? getCurrentVersion(options.cwd, options.packageName);
    const targetVersion = options.toVersion ?? (await getLatestVersion(options.cwd, options.packageName));

    spinner.text = "Getting AI migration analysis...";
    const patterns = await getAIPatterns(options.packageName, currentVersion, targetVersion);

    if (patterns.length === 0) {
      spinner.succeed("No code changes needed for this upgrade");
      process.stdout.write(
        chalk.green(`\n${options.packageName} ${currentVersion} → ${targetVersion} requires no code modifications.\n`)
      );
      process.stdout.write(chalk.gray("Run `upshift upgrade " + options.packageName + "` to apply the upgrade.\n"));
      return;
    }

    spinner.text = `Scanning codebase for ${patterns.length} patterns...`;
    const files = await findSourceFiles(options.cwd);

    const fixes: CodeFix[] = [];
    let astFixCount = 0;
    let regexFixCount = 0;

    for (const pattern of patterns) {
      const useAST = mode !== "regex" && pattern.astTransform && canHandleWithAST(pattern.astTransform);

      if (useAST) {
        // Try AST transform first
        try {
          const astResults = await applyASTTransform(
            files,
            pattern.astTransform!,
            true, // always dry-run at scan time; we apply separately
            options.cwd
          );

          const astFixes: CodeFix[] = astResults
            .filter((r) => r.changed)
            .flatMap((r) =>
              r.fixes.map((f) => ({
                file: f.file,
                line: f.line,
                original: f.original,
                replacement: f.replacement,
                description: f.description,
                mode: "ast" as const,
              }))
            );

          if (astFixes.length > 0) {
            fixes.push(...astFixes);
            astFixCount += astFixes.length;
            continue; // AST handled this pattern — skip regex
          }
        } catch {
          // AST failed — fall through to regex
        }
      }

      if (mode !== "ast") {
        const patternFixes = await findAndFixPattern(options.cwd, files, pattern);
        fixes.push(...patternFixes);
        regexFixCount += patternFixes.length;
      }
    }

    spinner.succeed(
      `Found ${fixes.length} code change${fixes.length === 1 ? "" : "s"} needed` +
        (astFixCount > 0 && regexFixCount > 0
          ? ` (${astFixCount} AST, ${regexFixCount} regex)`
          : astFixCount > 0
            ? ` (AST-aware)`
            : ` (pattern-match)`)
    );

    if (fixes.length === 0) {
      process.stdout.write(chalk.green("\nNo matching patterns found in your codebase.\n"));
      process.stdout.write(chalk.gray("Your code may already be compatible, or you're not using the affected APIs.\n"));
      return;
    }

    // JSON output
    if (options.json) {
      const result: FixResult = {
        package: options.packageName,
        fromVersion: currentVersion ?? null,
        toVersion: targetVersion,
        fixes,
        applied: false,
        confidence: astFixCount > 0 ? "medium" : "heuristic",
        astFixCount,
        regexFixCount,
      };
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    // Display fixes grouped by file
    const byFile = groupByFile(fixes);

    process.stdout.write(
      chalk.bold(`\n📝 Code changes for ${options.packageName} ${currentVersion ?? "?"} → ${targetVersion}:\n\n`)
    );

    for (const [file, fileFixes] of Object.entries(byFile)) {
      const relPath = path.relative(options.cwd, file);
      process.stdout.write(chalk.cyan(`${relPath}:\n`));

      for (const fix of fileFixes) {
        const modeTag = fix.mode === "ast" ? chalk.blue(" [AST]") : chalk.gray(" [regex]");
        process.stdout.write(chalk.gray(`  Line ${fix.line}:`) + modeTag + " " + chalk.yellow(fix.description) + "\n");
        if (fix.original) {
          process.stdout.write(chalk.red(`    - ${fix.original.trim()}\n`));
        }
        process.stdout.write(chalk.green(`    + ${fix.replacement.trim()}\n`));
      }
      process.stdout.write("\n");
    }

    // Dry run mode: print unified diff for PR review
    if (options.dryRun) {
      const diffText = buildUnifiedDiff(byFile, options.cwd);
      if (diffText) {
        process.stdout.write(chalk.bold("\n--- Unified diff (for PR review) ---\n"));
        process.stdout.write(chalk.gray(diffText));
        process.stdout.write(chalk.bold("---\n\n"));
      }

      const confidence: FixConfidence = astFixCount > 0 && regexFixCount === 0 ? "medium" : "heuristic";
      process.stdout.write(chalk.gray("Dry run — no changes applied.\n"));
      if (confidence === "medium") {
        process.stdout.write(chalk.blue("Confidence: medium (AST-aware transforms; run tests after applying).\n"));
      } else {
        process.stdout.write(chalk.yellow("Confidence: heuristic (pattern-match; review recommended).\n"));
      }
      process.stdout.write(chalk.gray("Remove --dry-run to apply these changes.\n"));
      return;
    }

    // Apply fixes
    if (options.yes || (await confirmApply(fixes.length))) {
      const applySpinner = ora("Applying fixes...").start();

      try {
        // Re-run AST transforms in write mode, then apply regex fixes
        await applyAllFixes(fixes, patterns, files, options.cwd);

        await emitAuditEvent("fix", "package", options.packageName, {
          applied: true,
          fix_count: fixes.length,
          ast_fix_count: astFixCount,
          regex_fix_count: regexFixCount,
          from_version: currentVersion ?? undefined,
          to_version: targetVersion,
        });

        applySpinner.succeed(`Applied ${fixes.length} fix${fixes.length === 1 ? "" : "es"}`);

        let confidence: FixConfidence = astFixCount > 0 && regexFixCount === 0 ? "medium" : "heuristic";
        try {
          const { runTests } = await import("./package-manager.js");
          await runTests(options.cwd);
          confidence = "high";
        } catch {
          // no test script or tests failed
        }

        if (confidence === "high") {
          process.stdout.write(chalk.green("\n✔ Code updated successfully! Confidence: high (tests passed).\n"));
        } else if (confidence === "medium") {
          process.stdout.write(chalk.green("\n✔ Code updated successfully!\n"));
          process.stdout.write(
            chalk.blue("Confidence: medium (AST-aware transforms applied; run your tests to verify).\n")
          );
        } else {
          process.stdout.write(chalk.green("\n✔ Code updated successfully!\n"));
          process.stdout.write(
            chalk.yellow("Confidence: heuristic (pattern-match; review and run tests recommended).\n")
          );
        }
        process.stdout.write(
          chalk.gray("Next: run `upshift upgrade " + options.packageName + "` to complete the version bump.\n")
        );
      } catch (err) {
        applySpinner.fail("Failed to apply some fixes");
        throw err;
      }
    } else {
      process.stdout.write(chalk.gray("\nNo changes applied.\n"));
    }
  } catch (error) {
    spinner.fail("Fix analysis failed");
    throw error;
  }
}

// ─── Version helpers ──────────────────────────────────────────────────────────

function getCurrentVersion(cwd: string, packageName: string): string | undefined {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;

  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  const version = pkg.dependencies?.[packageName] ?? pkg.devDependencies?.[packageName];
  return version?.replace(/^[\^~]/, "");
}

async function getLatestVersion(cwd: string, packageName: string): Promise<string> {
  const { runCommand } = await import("./exec.js");
  const result = await runCommand("npm", ["view", packageName, "version"], cwd);
  return result.stdout.trim();
}

// ─── Pattern types ────────────────────────────────────────────────────────────

type MigrationPattern = {
  pattern: string;
  replacement: string;
  description: string;
  regex?: boolean;
  /** Optional AST transform; if present and valid, used instead of regex/literal */
  astTransform?: ASTTransform;
};

// ─── AI pattern generation ────────────────────────────────────────────────────

async function getAIPatterns(
  packageName: string,
  fromVersion: string | undefined,
  toVersion: string
): Promise<MigrationPattern[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!apiKey && baseURL.includes("openai.com")) {
    throw new Error(
      "OPENAI_API_KEY not configured. Set it to enable AI-powered fixes.\n" +
        "Or use a local model: set OPENAI_BASE_URL=http://127.0.0.1:1234/v1 and OPENAI_MODEL=qwen/qwen3-14b"
    );
  }

  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: apiKey || "dummy", baseURL });

  const systemPrompt = `You are an expert at npm package migrations. Given a package upgrade, identify specific code patterns that need to change.

Return a JSON array of migration patterns. Each pattern must have:
- pattern: the old code pattern to find (simple regex or literal string)
- replacement: the new code to replace it with (use $1, $2 for regex capture groups)
- description: brief explanation of the change
- regex: true if pattern is a regex, false for literal string match

Additionally, if the change can be expressed as a structured AST transform, include an optional "astTransform" field:
{
  "type": one of: "rename-import-source" | "add-named-import" | "remove-named-import" |
                  "rename-named-import" | "rename-member-access" | "replace-member-call",
  "description": "...",
  // rename-import-source:
  "fromModule": "old-module",
  "toModule": "new-module",
  // add-named-import / remove-named-import / rename-named-import:
  "importModule": "from-module",
  "importName": "OriginalName",
  "importAlias": "NewName",   // for rename-named-import only
  // rename-member-access / replace-member-call:
  "objectName": "ObjName",
  "propertyName": "oldMethod",
  "newObjectName": "NewObj",       // optional; defaults to objectName
  "newPropertyName": "newMethod",  // for rename-member-access
  "newExpression": "createRoot({arg1}).render({arg0})", // for replace-member-call; {arg0},{arg1}=original args
  "addImport": { "name": "createRoot", "from": "react-dom/client" }  // optional injection
}

Focus on the most common breaking changes. Return 3-10 patterns max.
IMPORTANT: Return ONLY the JSON array, no markdown or explanation.`;

  const userPrompt = `Package: ${packageName}
From version: ${fromVersion ?? "unknown"}
To version: ${toVersion}

What code patterns need to change for this upgrade? Include astTransform where applicable.`;

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 2000,
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) return [];

  try {
    const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
    const patterns = JSON.parse(cleaned) as MigrationPattern[];
    return Array.isArray(patterns) ? patterns : [];
  } catch {
    console.error("Failed to parse AI response:", content);
    return [];
  }
}

// ─── File scanning ────────────────────────────────────────────────────────────

async function findSourceFiles(cwd: string): Promise<string[]> {
  const patterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];
  const ignorePatterns = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**"];
  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd, absolute: true, ignore: ignorePatterns });
    files.push(...matches);
  }

  return [...new Set(files)];
}

async function findAndFixPattern(cwd: string, files: string[], pattern: MigrationPattern): Promise<CodeFix[]> {
  const fixes: CodeFix[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");

      if (pattern.regex) {
        const regex = new RegExp(pattern.pattern, "g");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          regex.lastIndex = 0;
          if (regex.test(line)) {
            regex.lastIndex = 0;
            const replacement = line.replace(regex, pattern.replacement);
            if (replacement !== line) {
              fixes.push({
                file,
                line: i + 1,
                original: line,
                replacement,
                description: pattern.description,
                mode: "regex",
              });
            }
          }
        }
      } else {
        // Literal string match — find ALL occurrences across all lines
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes(pattern.pattern)) {
            const replacement = line.split(pattern.pattern).join(pattern.replacement);
            if (replacement !== line) {
              fixes.push({
                file,
                line: i + 1,
                original: line,
                replacement,
                description: pattern.description,
                mode: "literal",
              });
            }
          }
        }
      }
    } catch {
      // Skip files we can't read
    }
  }

  return fixes;
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/**
 * Re-run AST transforms in write mode for AST fixes, then apply regex/literal fixes via file rewrite.
 * We do this in two passes to avoid double-writing files.
 */
async function applyAllFixes(
  fixes: CodeFix[],
  patterns: MigrationPattern[],
  files: string[],
  cwd: string
): Promise<void> {
  // AST pass: re-run transforms with dryRun=false
  const astPatterns = patterns.filter((p) => p.astTransform && canHandleWithAST(p.astTransform));
  for (const pattern of astPatterns) {
    await applyASTTransform(files, pattern.astTransform!, false, cwd);
  }

  // Regex/literal pass: apply remaining fixes
  const regexFixes = fixes.filter((f) => f.mode !== "ast");
  if (regexFixes.length > 0) {
    applyRegexFixes(regexFixes);
  }
}

function applyRegexFixes(fixes: CodeFix[]): void {
  const byFile = groupByFile(fixes);

  for (const [file, fileFixes] of Object.entries(byFile)) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");

    // Apply in reverse order to preserve line numbers
    const sortedFixes = [...fileFixes].sort((a, b) => b.line - a.line);
    for (const fix of sortedFixes) {
      lines[fix.line - 1] = fix.replacement;
    }

    writeFileSync(file, lines.join("\n"), "utf8");
  }
}

function groupByFile(fixes: CodeFix[]): Record<string, CodeFix[]> {
  const groups: Record<string, CodeFix[]> = {};
  for (const fix of fixes) {
    if (!groups[fix.file]) groups[fix.file] = [];
    groups[fix.file].push(fix);
  }
  for (const file of Object.keys(groups)) {
    groups[file].sort((a, b) => a.line - b.line);
  }
  return groups;
}

async function confirmApply(count: number): Promise<boolean> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(chalk.yellow(`\nApply ${count} fix${count === 1 ? "" : "es"}? [y/N] `), (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

function buildUnifiedDiff(byFile: Record<string, CodeFix[]>, cwd: string): string {
  const chunks: string[] = [];
  for (const [file, fileFixes] of Object.entries(byFile)) {
    if (!existsSync(file)) continue;
    const oldContent = readFileSync(file, "utf8");
    const lines = oldContent.split("\n");
    const sortedFixes = [...fileFixes].sort((a, b) => b.line - a.line);
    for (const fix of sortedFixes) {
      if (fix.line >= 1 && fix.line <= lines.length) {
        lines[fix.line - 1] = fix.replacement;
      }
    }
    const newContent = lines.join("\n");
    const relPath = path.relative(cwd, file);
    const patch = createTwoFilesPatch(relPath, relPath, oldContent, newContent, "before", "after", { context: 3 });
    chunks.push(patch);
  }
  return chunks.join("");
}
