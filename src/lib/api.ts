export type BillingStatus = {
  tier: string;
  balance: number;
  bonusMultiplier: number;
};

export async function fetchBillingStatus(endpoint: string, token: string): Promise<BillingStatus | null> {
  try {
    const response = await fetch(`${endpoint}/billing/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as BillingStatus;
  } catch {
    return null;
  }
}
