if (!process.env.BILLING_SERVICE_URL) {
  throw new Error("[cloudflare-service] BILLING_SERVICE_URL is not set");
}
if (!process.env.BILLING_SERVICE_API_KEY) {
  throw new Error("[cloudflare-service] BILLING_SERVICE_API_KEY is not set");
}

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL;
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY;

export interface AuthorizeItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeResponse {
  sufficient: boolean;
  balance_cents: string;
  required_cents: string;
}

export interface AuthorizeArgs {
  orgId: string;
  userId: string;
  runId: string;
  items: AuthorizeItem[];
  description?: string;
  forwardHeaders?: Record<string, string>;
}

export async function authorizeCustomerBalance(
  args: AuthorizeArgs
): Promise<AuthorizeResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": BILLING_SERVICE_API_KEY,
    "x-org-id": args.orgId,
    "x-user-id": args.userId,
    "x-run-id": args.runId,
    ...(args.forwardHeaders ?? {}),
  };

  const response = await fetch(`${BILLING_SERVICE_URL}/v1/customer_balance/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items: args.items,
      ...(args.description ? { description: args.description } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `billing-service authorize failed: status=${response.status} body=${body}`
    );
  }

  return (await response.json()) as AuthorizeResponse;
}
