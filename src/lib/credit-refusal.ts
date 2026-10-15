export interface SalesFunnelCap {
  salesFunnelId: string;
  salesFunnelCampaignId: string;
  amountCents: number | string;
  period: string;
  consumedCents: number | string;
  reservedCents: number | string;
}

export interface AuthorizeResponse {
  sufficient: boolean;
  balance_cents: string;
  required_cents: string;
  /**
   * Present ONLY when billing refused because a sales funnel campaign's MAX
   * BUDGET is reached (or unreadable); absent on a real balance shortfall.
   */
  reason?: string;
  sales_funnel_cap?: SalesFunnelCap;
}

/**
 * The 402 body for a refused authorize. A real balance shortfall keeps the
 * historical body byte-identical. A sales-funnel max-budget refusal names its
 * real cause and passes billing's `reason` + `sales_funnel_cap` through
 * verbatim, so nobody tells the client to add credit when the org has credit.
 */
export function creditRefusalBody(authz: AuthorizeResponse): Record<string, unknown> {
  if (!authz.reason) {
    return {
      error: "Insufficient credit balance",
      reason: `balance=${authz.balance_cents} required=${authz.required_cents}`,
    };
  }
  return {
    error:
      authz.reason === "sales_funnel_max_budget_unreadable"
        ? "Sales funnel max budget could not be read"
        : "Sales funnel max budget reached",
    reason: authz.reason,
    ...(authz.sales_funnel_cap ? { sales_funnel_cap: authz.sales_funnel_cap } : {}),
    balance_cents: authz.balance_cents,
    required_cents: authz.required_cents,
  };
}
