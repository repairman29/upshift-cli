import { Command } from "commander";
import chalk from "chalk";
import {
  listTemplates,
  findTemplate,
  loadTemplateFromFile,
  applyTemplate,
  type MigrationTemplate,
} from "../lib/migrate.js";

export function migrateCommand(): Command {
  return new Command("migrate")
    .description("Apply a migration template for a package (e.g. React 18→19)")
    .argument("<package>", "Package name (e.g. react, next)")
    .option("--template <name>", "Template id (e.g. react-18-19); default: auto-detect from package")
    .option("--template-file <path>", "Path to a custom migration JSON file (overrides --template)")
    .option("--dry-run", "Show what would be changed without modifying files", false)
    .option("--list", "List available templates for the package")
    .option("--submit", "Submit a local template file to the Upshift community library")
    .option("--submit-file <path>", "Path to the template JSON to submit")
    .option("--cwd <path>", "Project directory", process.cwd())
    .action(async (pkg, options) => {
      const cwd = options.cwd ?? process.cwd();

      if (options.submit || options.submitFile) {
        await submitTemplate(options.submitFile, cwd);
        return;
      }

      if (options.list && !options.templateFile) {
        const templates = listTemplates(pkg);
        if (templates.length === 0) {
          process.stdout.write(chalk.yellow(`No migration templates found for "${pkg}".\n`));
          process.stdout.write(
            chalk.gray(
              "Run `upshift migrate <package>` without --list to see all templates, or use --template-file <path> for a custom template.\n"
            )
          );
          return;
        }
        process.stdout.write(chalk.bold(`Templates for ${pkg}:\n\n`));
        for (const t of templates) {
          process.stdout.write(`  ${chalk.cyan(t.name)} — ${t.description}\n`);
          process.stdout.write(`    ${t.from} → ${t.to}\n`);
          if (t.links?.length) {
            process.stdout.write(`    ${chalk.gray(t.links[0])}\n`);
          }
          process.stdout.write("\n");
        }
        return;
      }

      let template: MigrationTemplate | null;
      if (options.templateFile) {
        template = loadTemplateFromFile(options.templateFile, cwd);
        if (!template) {
          process.stdout.write(chalk.yellow(`Could not load template from "${options.templateFile}".\n`));
          process.stdout.write(chalk.gray("File must be valid JSON with package and steps.\n"));
          process.exit(1);
        }
      } else if (options.template) {
        const all = listTemplates(pkg);
        template = all.find((t) => t.name === options.template) ?? all[0] ?? null;
      } else {
        template = findTemplate(pkg);
      }

      if (!template) {
        process.stdout.write(chalk.yellow(`No migration template found for "${pkg}".\n`));
        process.stdout.write(
          chalk.gray("Add one in migrations/ or run `upshift migrate --list` to see available templates.\n")
        );
        process.exit(1);
      }

      process.stdout.write(chalk.bold(`Applying template: ${template.name}\n`));
      process.stdout.write(chalk.gray(`${template.description}\n\n`));

      const result = applyTemplate({
        cwd,
        template,
        dryRun: options.dryRun ?? false,
      });

      // Per-step breakdown
      for (const sr of result.stepResults) {
        if (sr.skipped) {
          process.stdout.write(chalk.gray(`  ↓ ${sr.description} — no match found\n`));
        } else if (sr.filesModified.length === 0) {
          // package step
          process.stdout.write(chalk.cyan(`  ○ ${sr.description}\n`));
        } else {
          const fileWord = sr.filesModified.length === 1 ? "file" : "files";
          const occWord = sr.occurrences === 1 ? "occurrence" : "occurrences";
          process.stdout.write(
            chalk.green(`  ✔ ${sr.description}`) +
              chalk.gray(` — ${sr.occurrences} ${occWord} in ${sr.filesModified.length} ${fileWord}\n`)
          );
          for (const f of sr.filesModified) {
            process.stdout.write(chalk.gray(`      ${f}\n`));
          }
        }
      }

      if (result.packageSteps.length > 0) {
        process.stdout.write(chalk.cyan("\nPackage bumps (run to complete the upgrade):\n"));
        for (const s of result.packageSteps) {
          process.stdout.write(`  upshift upgrade ${s.package}${s.version ? ` --to ${s.version}` : ""}\n`);
        }
      }

      if (options.dryRun) {
        process.stdout.write(chalk.gray("\nDry run — no files modified. Remove --dry-run to apply.\n"));
      } else {
        const totalFiles = result.filesModified.length;
        const totalOcc = result.totalOccurrences;
        const fileWord = totalFiles === 1 ? "file" : "files";
        const occWord = totalOcc === 1 ? "occurrence" : "occurrences";
        process.stdout.write(
          chalk.green(
            `\nApplied ${result.stepsApplied} step(s): ${totalOcc} ${occWord} across ${totalFiles} ${fileWord}.` +
              (result.stepsSkipped > 0 ? ` ${result.stepsSkipped} step(s) skipped (no match).` : "") +
              "\n"
          )
        );
      }

      if (template.links?.length) {
        process.stdout.write(chalk.gray("\nGuides: " + template.links.join(", ") + "\n"));
      }
    });
}

async function submitTemplate(filePath: string | undefined, cwd: string): Promise<void> {
  const chalk = (await import("chalk")).default;
  const fs = await import("fs");
  const path = await import("path");
  const readline = await import("readline");

  // Find the template file
  let templatePath: string;
  if (filePath) {
    templatePath = path.resolve(filePath);
  } else {
    // Look for .upshift-template.json in cwd
    templatePath = path.join(cwd, ".upshift-template.json");
  }

  if (!fs.existsSync(templatePath)) {
    console.error(chalk.red(`Template file not found: ${templatePath}`));
    console.error(chalk.gray("\nCreate a migration template and save it as .upshift-template.json"));
    console.error(chalk.gray("Or specify: upshift migrate --submit --submit-file <path>"));
    process.exit(1);
  }

  let template: Record<string, unknown>;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  } catch {
    console.error(chalk.red("Could not parse template JSON. Ensure it is valid JSON."));
    process.exit(1);
  }

  // Validate required fields
  const required = ["id", "name", "package", "fromVersion", "toVersion", "steps"];
  const missing = required.filter((k) => !(k in template));
  if (missing.length > 0) {
    console.error(chalk.red(`Template missing required fields: ${missing.join(", ")}`));
    process.exit(1);
  }

  // Preview
  console.log("");
  console.log(chalk.bold("  Template preview:"));
  console.log("");
  console.log(`  ID:       ${chalk.cyan(String(template.id))}`);
  console.log(`  Name:     ${template.name}`);
  console.log(`  Package:  ${template.package} ${template.fromVersion} → ${template.toVersion}`);
  console.log(`  Steps:    ${Array.isArray(template.steps) ? template.steps.length : "?"}`);
  console.log("");

  // Confirm
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmed = await new Promise<boolean>((resolve) => {
    rl.question(chalk.yellow("  Submit this template to the Upshift community library? [y/N] "), (ans) => {
      rl.close();
      resolve(ans.toLowerCase() === "y" || ans.toLowerCase() === "yes");
    });
  });

  if (!confirmed) {
    console.log(chalk.gray("  Cancelled."));
    return;
  }

  // Submit
  const apiBase = process.env.UPSHIFT_API_URL || "https://upshiftai.dev";
  const apiToken = process.env.UPSHIFT_API_TOKEN;

  const spinner = (await import("ora")).default("Submitting template...").start();

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;

    const res = await fetch(`${apiBase}/api/templates/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ template }),
    });

    if (res.status === 401) {
      spinner.fail("Authentication required");
      console.error(
        chalk.yellow(
          "\n  Set UPSHIFT_API_TOKEN to submit templates. Get a token at https://upshiftai.dev/dashboard/api-keys"
        )
      );
      process.exit(1);
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      spinner.fail(`Submission failed: ${(data as any).error || res.status}`);
      process.exit(1);
    }

    spinner.succeed("Template submitted!");
    console.log(chalk.gray("\n  Your template will be reviewed and published to the community library."));
    console.log(chalk.gray("  Track status at: https://upshiftai.dev/community/templates"));
    console.log("");
  } catch (err) {
    spinner.fail("Network error");
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
