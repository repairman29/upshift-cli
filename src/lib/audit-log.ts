/**
 * Optional audit event emission for platform (Team/Enterprise).
 * When UPSHIFT_AUDIT_URL is set, the CLI POSTs events after upgrade/fix/scan-upload.
 * Point it at the billing server `POST /audit/ingest` (Bearer `UPSHIFT_API_TOKEN` must match
 * `UPSHIFT_API_KEYS` on the server) to append JSON lines to `~/.upshift/audit-ingest.jsonl`.
 * No-op if URL is not set.
 */

export type AuditEventType = "upgrade" | "fix" | "scan_upload";

export type AuditEventPayload = {
  event_type: AuditEventType;
  resource_type: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
  org_id?: string;
  timestamp: string;
  /** Optional: set by platform from env */
  user_agent?: string;
};

function getAuditUrl(): string | undefined {
  return process.env.UPSHIFT_AUDIT_URL?.trim() || undefined;
}

function getOrgId(): string | undefined {
  return process.env.UPSHIFT_ORG?.trim() || undefined;
}

/**
 * Emit an audit event to the platform. No-op if UPSHIFT_AUDIT_URL is not set.
 * Fire-and-forget: does not throw; failures are ignored so CLI flow is unaffected.
 */
export async function emitAuditEvent(
  eventType: AuditEventType,
  resourceType: string,
  resourceId: string | undefined,
  metadata?: Record<string, unknown>
): Promise<void> {
  const url = getAuditUrl();
  if (!url) return;

  const payload: AuditEventPayload = {
    event_type: eventType,
    resource_type: resourceType,
    resource_id: resourceId,
    metadata: { ...metadata },
    org_id: getOrgId(),
    timestamp: new Date().toISOString(),
  };

  try {
    const token = process.env.UPSHIFT_API_TOKEN?.trim();
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Fire-and-forget: do not throw
  }
}
