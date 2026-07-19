/**
 * upshift release
 *
 * Generate a CHANGELOG entry from git history since the last tag.
 * Groups commits by type (feat, fix, chore, etc.) and outputs
 * formatted Markdown ready for CHANGELOG.md or a GitHub release.
 */
import { Command } from "commander";
import chalk from "chalk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Commit {
  hash: string;
  type: string;
  scope?: string;
  message: string;
  breaking: boolean;
}

const TYPE_ORDER = ["feat", "fix", "perf", "refactor", "docs", "chore", "ci", "test", "build", "style", "revert"];
const TYPE_LABELS: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  chore: "Chores",
  ci: "CI",
  test: "Tests",
  build: "Build",
  style: "Style",
  revert: "Reverts",
};

export function releaseCommand(): Command {
  return new Command("release")
    .description("Generate a CHANGELOG entry from git commits since last tag")
    .option("--cwd <path>", "Project directory", process.cwd())
    .option("--from <tag>", "Start from this tag/commit (default: last tag)")
    .option("--to <ref>", "End at this ref (default: HEAD)")
    .option("--version <ver>", "Version label for the heading (default: auto-detect from package.json)")
    .option("--output <file>", "Prepend to file instead of stdout (e.g. CHANGELOG.md)")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const cwd = path.resolve(options.cwd);

      try {
        // Determine range
        const toRef = options.to ?? "HEAD";
        let fromRef = options.from;
        if (!fromRef) {
          try {
            fromRef = execSync("git describe --tags --abbrev=0 HEAD^", { cwd, stdio: ["pipe", "pipe", "pipe"] })
              .toString()
              .trim();
          } catch {
            // No previous tag — use first commit
            try {
              fromRef = execSync("git rev-list --max-parents=0 HEAD", { cwd, stdio: ["pipe", "pipe", "pipe"] })
                .toString()
                .trim();
            } catch {
              console.error(chalk.red("Not a git repository or no commits found."));
              process.exit(1);
            }
          }
        }

        // Determine version
        let version = options.version;
        if (!version) {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
            version = `v${pkg.version}`;
          } catch {
            version = "Unreleased";
          }
        }

        // Get commits in range
        const logOutput = execSync(`git log ${fromRef}..${toRef} --format="%H|||%s"`, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
        })
          .toString()
          .trim();

        if (!logOutput) {
          console.log(chalk.gray(`No commits found between ${fromRef} and ${toRef}.`));
          return;
        }

        const rawCommits = logOutput.split("\n").filter(Boolean);
        const commits: Commit[] = [];

        for (const line of rawCommits) {
          const [hash, ...subjectParts] = line.split("|||");
          const subject = subjectParts.join("|||").trim();

          // Parse Conventional Commits: type(scope)!: message
          const match = subject.match(/^(\w+)(\(([^)]+)\))?(!)?\s*:\s*(.+)$/);
          if (match) {
            const [, type, , scope, bang, message] = match;
            commits.push({
              hash: hash.slice(0, 7),
              type: type.toLowerCase(),
              scope,
              message,
              breaking: !!bang,
            });
          } else {
            // Non-conventional commit — categorize as chore
            commits.push({ hash: hash.slice(0, 7), type: "chore", message: subject, breaking: false });
          }
        }

        // Group by type
        const grouped = new Map<string, Commit[]>();
        const breaking: Commit[] = commits.filter((c) => c.breaking);

        for (const commit of commits) {
          if (!grouped.has(commit.type)) grouped.set(commit.type, []);
          grouped.get(commit.type)!.push(commit);
        }

        if (options.json) {
          process.stdout.write(
            JSON.stringify(
              {
                version,
                from: fromRef,
                to: toRef,
                total: commits.length,
                breaking: breaking.length,
                commits,
                grouped: Object.fromEntries([...grouped.entries()].map(([k, v]) => [k, v.length])),
              },
              null,
              2
            ) + "\n"
          );
          return;
        }

        // Build Markdown
        const lines: string[] = [];
        const date = new Date().toISOString().slice(0, 10);
        lines.push(`## ${version} (${date})`);
        lines.push("");

        if (breaking.length > 0) {
          lines.push("### ⚠ Breaking Changes");
          lines.push("");
          for (const c of breaking) {
            const scope = c.scope ? `**${c.scope}:** ` : "";
            lines.push(`- ${scope}${c.message} ([${c.hash}])`);
          }
          lines.push("");
        }

        const orderedTypes = [...TYPE_ORDER, ...[...grouped.keys()].filter((t) => !TYPE_ORDER.includes(t))];

        for (const type of orderedTypes) {
          const typeCommits = grouped.get(type);
          if (!typeCommits?.length) continue;
          if (type === "chore" && typeCommits.every((c) => c.message.includes("Co-Authored"))) continue;

          const label = TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
          lines.push(`### ${label}`);
          lines.push("");
          for (const c of typeCommits) {
            if (c.breaking) continue; // already in Breaking Changes
            const scope = c.scope ? `**${c.scope}:** ` : "";
            lines.push(`- ${scope}${c.message} ([${c.hash}])`);
          }
          lines.push("");
        }

        const markdown = lines.join("\n");

        if (options.output) {
          const outPath = path.resolve(options.output);
          let existing = "";
          try {
            existing = fs.readFileSync(outPath, "utf8");
          } catch {
            /* new file */
          }
          fs.writeFileSync(outPath, markdown + "\n" + existing, "utf8");
          console.log(chalk.green(`✔ Prepended changelog entry to ${outPath}`));
          console.log(chalk.gray(`  Version: ${version} · ${commits.length} commits · ${breaking.length} breaking`));
        } else {
          process.stdout.write(markdown + "\n");
        }

        // Human summary to stderr (so stdout stays clean for piping)
        if (!options.output) {
          process.stderr.write(
            chalk.gray(`\n  ${commits.length} commits · ${breaking.length} breaking · from ${fromRef}\n\n`)
          );
        }
      } catch (err) {
        console.error(chalk.red("Release generation failed:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
