import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";

interface NpmPackageData {
  versions?: Record<string, { description?: string }>;
  repository?: { url?: string } | string;
  homepage?: string;
  bugs?: { url?: string } | string;
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  prerelease?: boolean;
}

export function changelogCommand(): Command {
  return new Command("changelog")
    .description("Fetch release notes for a package between two versions")
    .argument("<package>", "Package name (e.g. react, next, vue)")
    .option("--from <version>", "Starting version (default: currently installed)")
    .option("--to <version>", "Target version (default: latest)")
    .option("--cwd <path>", "Project directory (to detect installed version)", process.cwd())
    .option("--json", "Output as JSON")
    .option("--limit <n>", "Max releases to show", "10")
    .action(async (packageName: string, options) => {
      const spinner = ora(`Fetching changelog for ${packageName}...`).start();

      try {
        // Detect installed version if --from not specified
        let fromVersion = options.from;
        if (!fromVersion) {
          fromVersion = await getInstalledVersion(packageName, options.cwd);
        }

        // Fetch npm metadata to get GitHub URL
        const npmMeta = await fetchNpmMeta(packageName);
        const repoUrl = extractGithubUrl(npmMeta);

        // Fetch latest version if --to not specified
        const toVersion = options.to ?? (await getLatestVersion(packageName));

        spinner.stop();

        if (!repoUrl) {
          // Fallback: show npm changelog link
          console.log("");
          console.log(chalk.bold(`  ${packageName}  ${fromVersion ?? "?"} → ${toVersion}`));
          console.log("");
          console.log(chalk.gray("  No GitHub repository found. View changelog at:"));
          console.log(chalk.cyan(`  https://www.npmjs.com/package/${packageName}?activeTab=versions`));
          if (npmMeta.homepage) {
            console.log(chalk.cyan(`  ${npmMeta.homepage}`));
          }
          console.log("");
          return;
        }

        // Extract owner/repo from GitHub URL
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) {
          console.log(chalk.yellow(`  Could not parse GitHub URL: ${repoUrl}`));
          return;
        }
        const [, owner, repo] = match;

        // Fetch releases from GitHub API
        const releases = await fetchGithubReleases(owner, repo, parseInt(options.limit, 10) || 10);

        if (options.json) {
          process.stdout.write(
            JSON.stringify(
              {
                package: packageName,
                from: fromVersion,
                to: toVersion,
                repository: `https://github.com/${owner}/${repo}`,
                releases,
              },
              null,
              2
            ) + "\n"
          );
          return;
        }

        console.log("");
        console.log(chalk.bold(`  ${packageName}  ${fromVersion ?? "?"} → ${toVersion}`));
        console.log(chalk.gray(`  Source: https://github.com/${owner}/${repo}/releases`));
        console.log("");

        if (releases.length === 0) {
          console.log(chalk.gray("  No releases found on GitHub. Check the repository directly."));
          console.log("");
          return;
        }

        let shown = 0;
        for (const release of releases) {
          if (release.prerelease) continue;
          const date = release.published_at
            ? new Date(release.published_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : "";
          const tag = release.name || release.tag_name;
          console.log(chalk.bold.cyan(`  ${tag}`) + (date ? chalk.gray(`  ${date}`) : ""));
          if (release.html_url) console.log(chalk.gray(`  ${release.html_url}`));
          if (release.body) {
            const lines = release.body.trim().split("\n").slice(0, 8);
            for (const line of lines) {
              // Strip markdown heading hashes, keep content
              const clean = line.replace(/^#{1,3}\s*/, "").trim();
              if (clean) console.log(chalk.gray(`    ${clean}`));
            }
            if (release.body.split("\n").length > 8) {
              console.log(chalk.gray(`    ... (see full notes at ${release.html_url})`));
            }
          }
          console.log("");
          shown++;
          if (shown >= (parseInt(options.limit, 10) || 10)) break;
        }

        console.log(chalk.gray(`  Full releases: https://github.com/${owner}/${repo}/releases`));
        console.log("");
      } catch (err) {
        spinner.fail("Changelog fetch failed");
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function getInstalledVersion(packageName: string, cwd: string): Promise<string | undefined> {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const instPkg = JSON.parse(fs.readFileSync(path.join(cwd, "node_modules", packageName, "package.json"), "utf8"));
    return instPkg.version;
  } catch {
    return undefined;
  }
}

async function fetchNpmMeta(packageName: string): Promise<NpmPackageData> {
  const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
  if (!res.ok) throw new Error(`npm registry returned ${res.status} for ${packageName}`);
  return res.json() as Promise<NpmPackageData>;
}

async function getLatestVersion(packageName: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
  if (!res.ok) return "latest";
  const data = (await res.json()) as { version?: string };
  return data.version ?? "latest";
}

function extractGithubUrl(meta: NpmPackageData): string | null {
  const repoField = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  if (repoField?.includes("github.com")) return repoField;
  if (meta.homepage?.includes("github.com")) return meta.homepage;
  const bugsUrl = typeof meta.bugs === "string" ? meta.bugs : meta.bugs?.url;
  if (bugsUrl?.includes("github.com")) return bugsUrl;
  return null;
}

async function fetchGithubReleases(owner: string, repo: string, limit: number): Promise<GithubRelease[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${Math.min(limit * 2, 30)}`,
    { headers }
  );

  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return res.json() as Promise<GithubRelease[]>;
}
