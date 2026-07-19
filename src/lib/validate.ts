/**
 * Input validation schemas for CLI arguments and API payloads.
 * All external-boundary inputs (user CLI args, webhook URLs, env vars) are
 * validated here before being used in network calls or file-system operations.
 */
import { z, type ZodIssue } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** npm package name: optionally scoped (@scope/name), letters/digits/-/._  */
export const packageNameSchema = z
  .string()
  .min(1, "Package name cannot be empty")
  .max(214, "Package name too long")
  .regex(
    /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i,
    "Invalid package name (use npm naming conventions)"
  );

/** Semver version string OR "latest"/"next"/"beta" dist-tags */
export const versionSchema = z
  .string()
  .min(1, "Version cannot be empty")
  .max(64, "Version string too long")
  .regex(
    /^(?:latest|next|beta|alpha|rc|canary|\d+\.\d+[\w.\-+]*)$/i,
    'Invalid version — use semver (e.g. "1.2.3") or a dist-tag ("latest")'
  );

/** File-system path: no null bytes, not suspiciously long */
export const fsPathSchema = z
  .string()
  .min(1, "Path cannot be empty")
  .max(4096, "Path too long")
  .refine((p) => !p.includes("\0"), "Path must not contain null bytes");

/** HTTPS/HTTP webhook URL */
export const webhookUrlSchema = z
  .string()
  .url("Must be a valid URL")
  .refine((u) => u.startsWith("https://") || u.startsWith("http://"), "Webhook URL must use http or https");

/** Org ID: UUID format */
export const orgIdSchema = z.string().uuid("UPSHIFT_ORG must be a UUID");

// ---------------------------------------------------------------------------
// Command-specific option schemas
// ---------------------------------------------------------------------------

export const upgradeOptionsSchema = z.object({
  cwd: fsPathSchema,
  packageName: packageNameSchema.optional(),
  toVersion: versionSchema.optional(),
  dryRun: z.boolean().default(false),
  yes: z.boolean().optional(),
  skipTests: z.boolean().optional(),
});

export const fixOptionsSchema = z.object({
  cwd: fsPathSchema,
  packageName: packageNameSchema,
  fromVersion: versionSchema.optional(),
  toVersion: versionSchema.optional(),
  dryRun: z.boolean().default(false),
  yes: z.boolean().optional(),
  json: z.boolean().optional(),
});

export const scanOptionsSchema = z.object({
  cwd: fsPathSchema,
  json: z.boolean().default(false),
  licenses: z.boolean().default(false),
  report: fsPathSchema.optional(),
  uploadUrl: webhookUrlSchema.optional(),
  uploadToken: z.string().min(1).max(256).optional(),
});

export const notifyOptionsSchema = z.object({
  cwd: fsPathSchema,
  slack: webhookUrlSchema.optional(),
  discord: webhookUrlSchema.optional(),
  webhook: webhookUrlSchema.optional(),
  test: z.boolean().optional(),
});

/** Audit-events Edge Function POST body */
export const auditEventPayloadSchema = z.object({
  event_type: z.string().min(1).max(64),
  resource_type: z.string().min(1).max(64),
  resource_id: z.string().max(256).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  org_id: z.string().max(256).optional(),
  timestamp: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Helper: validate or exit with a clear error
// ---------------------------------------------------------------------------

export function validateOrExit<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = result.error;
    const issues: ZodIssue[] =
      "issues" in err && Array.isArray(err.issues)
        ? err.issues
        : "errors" in err && Array.isArray((err as { errors: ZodIssue[] }).errors)
          ? (err as { errors: ZodIssue[] }).errors
          : [];
    const messages = issues.map((e) => `  ${(e.path ?? []).map(String).join(".")}: ${e.message}`).join("\n");
    console.error(`Validation error:\n${messages}`);
    process.exit(1);
  }
  return result.data;
}
