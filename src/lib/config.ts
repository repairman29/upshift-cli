import { existsSync, readFileSync } from "fs";
import path from "path";

export type UpshiftConfig = {
  // Packages to always skip when upgrading
  ignore?: string[];

  // Default upgrade mode: "all" | "minor" | "patch"
  defaultMode?: "all" | "minor" | "patch";

  // Auto-run tests after upgrade
  autoTest?: boolean;

  // Skip confirmation prompts
  autoConfirm?: boolean;

  // AI settings
  ai?: {
    // Auto-enable AI for explains
    autoEnable?: boolean;
    // Max credits to use per session
    maxCredits?: number;
  };

  // Scan settings
  scan?: {
    // Exclude these packages from scan results
    exclude?: string[];
    // Only show packages above this severity
    minSeverity?: "low" | "moderate" | "high" | "critical";
  };

  // Approval / HITL: require confirmation for risky upgrades (e.g. major)
  approval?: {
    mode?: "prompt" | "none" | "webhook";
    requireFor?: ("major" | "all")[];
    webhookUrl?: string; // POST proposed upgrade; 200 = approve, non-200 = reject
  };

  // Upgrade policy: block upgrades above a risk level (e.g. block high-risk unless approved)
  upgradePolicy?: {
    blockRisk?: ("high" | "medium")[]; // e.g. ["high"] = block high-risk upgrades
  };

  // Registry settings
  registry?: {
    // Custom npm registry URL
    url?: string;
    // Auth token (use env var reference like $NPM_TOKEN)
    token?: string;
  };

  // Test command: run after upgrade; rollback if non-zero. e.g. "pytest", ["poetry", "run", "pytest"], or "npm run build".
  // Works for every ecosystem; Node falls back to the package.json "test" script when unset.
  testCommand?: string | string[];
};

const CONFIG_FILES = [".upshiftrc.json", ".upshiftrc", "upshift.config.json"];

const DEFAULT_CONFIG: UpshiftConfig = {
  ignore: [],
  defaultMode: "minor",
  autoTest: true,
  autoConfirm: false,
  ai: {
    autoEnable: false,
    maxCredits: 50,
  },
  scan: {
    exclude: [],
    minSeverity: "low",
  },
  approval: {
    mode: "prompt",
    requireFor: ["major"],
    webhookUrl: undefined,
  },
  upgradePolicy: undefined,
};

let cachedConfig: UpshiftConfig | null = null;

export function loadConfig(cwd: string = process.cwd()): UpshiftConfig {
  if (cachedConfig) return cachedConfig;

  for (const filename of CONFIG_FILES) {
    const configPath = path.join(cwd, filename);
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf8");
        const userConfig = JSON.parse(raw) as Partial<UpshiftConfig>;
        cachedConfig = mergeConfig(DEFAULT_CONFIG, userConfig);
        return cachedConfig;
      } catch (error) {
        console.warn(`Warning: Failed to parse ${filename}: ${error}`);
      }
    }
  }

  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

export function clearConfigCache(): void {
  cachedConfig = null;
}

function mergeConfig(defaults: UpshiftConfig, user: Partial<UpshiftConfig>): UpshiftConfig {
  return {
    ...defaults,
    ...user,
    ai: { ...defaults.ai, ...user.ai },
    scan: { ...defaults.scan, ...user.scan },
    approval: user.approval
      ? {
          ...defaults.approval,
          ...user.approval,
          webhookUrl: user.approval.webhookUrl ?? defaults.approval?.webhookUrl,
        }
      : defaults.approval,
    upgradePolicy: user.upgradePolicy ? { ...defaults.upgradePolicy, ...user.upgradePolicy } : defaults.upgradePolicy,
    registry: user.registry ? { ...defaults.registry, ...user.registry } : defaults.registry,
  };
}

/** Parse a testCommand config value into [command, ...args], or null when unset/empty. */
export function parseTestCommand(tc: string | string[] | undefined): string[] | null {
  if (!tc) return null;
  if (Array.isArray(tc)) return tc.length > 0 ? tc : null;
  const parts = tc.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export function shouldIgnorePackage(config: UpshiftConfig, packageName: string): boolean {
  if (!config.ignore || config.ignore.length === 0) return false;

  return config.ignore.some((pattern) => {
    if (pattern.includes("*")) {
      // Simple glob matching
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      return regex.test(packageName);
    }
    return packageName === pattern;
  });
}

export function createConfigTemplate(): string {
  return JSON.stringify(
    {
      $schema: "https://upshiftai.dev/schema/config.json",
      ignore: ["@types/*"],
      defaultMode: "minor",
      autoTest: true,
      autoConfirm: false,
      ai: {
        autoEnable: false,
        maxCredits: 50,
      },
      scan: {
        exclude: [],
        minSeverity: "low",
      },
      approval: {
        mode: "prompt",
        requireFor: ["major"],
        webhookUrl: undefined, // optional: POST upgrade_proposed for HITL; 200 = approve
      },
      upgradePolicy: undefined, // optional: { blockRisk: ["high"] } to block high-risk upgrades
    },
    null,
    2
  );
}
