import { existsSync, readFileSync } from "fs";
import path from "path";
import { glob } from "glob";

export type MonorepoType =
  | "npm-workspaces"
  | "yarn-workspaces"
  | "pnpm-workspaces"
  | "lerna"
  | "turborepo"
  | "nx"
  | "none";

export type WorkspaceInfo = {
  name: string;
  path: string;
  packageJson: {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
};

export type MonorepoInfo = {
  type: MonorepoType;
  root: string;
  workspaces: WorkspaceInfo[];
};

export function detectMonorepo(cwd: string): MonorepoInfo {
  const type = detectMonorepoType(cwd);

  if (type === "none") {
    return { type: "none", root: cwd, workspaces: [] };
  }

  const workspaces = getWorkspaces(cwd, type);

  return {
    type,
    root: cwd,
    workspaces,
  };
}

function detectMonorepoType(cwd: string): MonorepoType {
  const packageJsonPath = path.join(cwd, "package.json");

  // Check for monorepo config files
  if (existsSync(path.join(cwd, "pnpm-workspace.yaml"))) {
    return "pnpm-workspaces";
  }

  if (existsSync(path.join(cwd, "lerna.json"))) {
    return "lerna";
  }

  if (existsSync(path.join(cwd, "turbo.json"))) {
    return "turborepo";
  }

  if (existsSync(path.join(cwd, "nx.json"))) {
    return "nx";
  }

  // Check package.json for workspaces
  if (existsSync(packageJsonPath)) {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw) as {
      workspaces?: string[] | { packages?: string[] };
    };

    if (pkg.workspaces) {
      // Check if yarn.lock exists to determine yarn vs npm
      if (existsSync(path.join(cwd, "yarn.lock"))) {
        return "yarn-workspaces";
      }
      return "npm-workspaces";
    }
  }

  return "none";
}

function getWorkspaces(cwd: string, type: MonorepoType): WorkspaceInfo[] {
  let patterns: string[] = [];

  if (type === "pnpm-workspaces") {
    patterns = getPnpmWorkspacePatterns(cwd);
  } else if (type === "lerna") {
    patterns = getLernaWorkspacePatterns(cwd);
  } else if (type === "npm-workspaces" || type === "yarn-workspaces") {
    patterns = getNpmWorkspacePatterns(cwd);
  } else if (type === "turborepo" || type === "nx") {
    // Turborepo and Nx typically use npm/yarn/pnpm workspaces under the hood
    patterns = getNpmWorkspacePatterns(cwd);
    if (patterns.length === 0) {
      patterns = getPnpmWorkspacePatterns(cwd);
    }
  }

  if (patterns.length === 0) {
    return [];
  }

  // Expand glob patterns to find workspace directories
  const workspaceDirs: string[] = [];

  for (const pattern of patterns) {
    // Handle glob patterns
    if (pattern.includes("*")) {
      const matches = glob.sync(pattern, {
        cwd,
        absolute: false,
        ignore: ["**/node_modules/**"],
      });
      workspaceDirs.push(...matches);
    } else {
      // Direct path
      if (existsSync(path.join(cwd, pattern, "package.json"))) {
        workspaceDirs.push(pattern);
      }
    }
  }

  // Load workspace info
  const workspaces: WorkspaceInfo[] = [];

  for (const dir of workspaceDirs) {
    const fullPath = path.join(cwd, dir);
    const pkgPath = path.join(fullPath, "package.json");

    if (existsSync(pkgPath)) {
      try {
        const raw = readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw);

        workspaces.push({
          name: pkg.name || dir,
          path: fullPath,
          packageJson: pkg,
        });
      } catch {
        // Skip invalid package.json
      }
    }
  }

  return workspaces;
}

function getPnpmWorkspacePatterns(cwd: string): string[] {
  const configPath = path.join(cwd, "pnpm-workspace.yaml");

  if (!existsSync(configPath)) return [];

  const raw = readFileSync(configPath, "utf8");

  // Simple YAML parsing for packages array
  const packagesMatch = raw.match(/packages:\s*\n((?:\s+-\s*.+\n?)+)/);
  if (!packagesMatch) return [];

  const lines = packagesMatch[1].split("\n");
  const patterns: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (match) {
      patterns.push(match[1]);
    }
  }

  return patterns;
}

function getLernaWorkspacePatterns(cwd: string): string[] {
  const configPath = path.join(cwd, "lerna.json");

  if (!existsSync(configPath)) return ["packages/*"];

  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as { packages?: string[] };

  return config.packages || ["packages/*"];
}

function getNpmWorkspacePatterns(cwd: string): string[] {
  const packageJsonPath = path.join(cwd, "package.json");

  if (!existsSync(packageJsonPath)) return [];

  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as {
    workspaces?: string[] | { packages?: string[] };
  };

  if (!pkg.workspaces) return [];

  if (Array.isArray(pkg.workspaces)) {
    return pkg.workspaces;
  }

  return pkg.workspaces.packages || [];
}

export function getAllDependencies(monorepo: MonorepoInfo): Map<string, { version: string; workspaces: string[] }> {
  const deps = new Map<string, { version: string; workspaces: string[] }>();

  for (const workspace of monorepo.workspaces) {
    const allDeps = {
      ...workspace.packageJson.dependencies,
      ...workspace.packageJson.devDependencies,
    };

    for (const [name, version] of Object.entries(allDeps)) {
      const existing = deps.get(name);
      if (existing) {
        existing.workspaces.push(workspace.name);
        // Track version conflicts
        if (existing.version !== version) {
          existing.version = `${existing.version}, ${version}`;
        }
      } else {
        deps.set(name, { version, workspaces: [workspace.name] });
      }
    }
  }

  return deps;
}

export function formatMonorepoSummary(monorepo: MonorepoInfo): string {
  if (monorepo.type === "none") {
    return "Single package (not a monorepo)";
  }

  return `${monorepo.type} with ${monorepo.workspaces.length} packages`;
}
