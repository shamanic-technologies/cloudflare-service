const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY;

interface CallerContext {
  callerMethod: string;
  callerPath: string;
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
}

export async function decryptKey(
  provider: string,
  orgId: string,
  userId: string,
  caller: CallerContext
): Promise<{ key: string; keySource: "platform" | "org" }> {
  const response = await fetch(`${KEY_SERVICE_URL}/keys/${provider}/decrypt`, {
    headers: {
      ...(KEY_SERVICE_API_KEY ? { "X-Api-Key": KEY_SERVICE_API_KEY } : {}),
      "x-org-id": orgId,
      "x-user-id": userId,
      "X-Caller-Service": "cloudflare-storage",
      "X-Caller-Method": caller.callerMethod,
      "X-Caller-Path": caller.callerPath,
      ...(caller.campaignId ? { "x-campaign-id": caller.campaignId } : {}),
      ...(caller.brandIds?.length ? { "x-brand-id": caller.brandIds.join(",") } : {}),
      ...(caller.workflowSlug ? { "x-workflow-slug": caller.workflowSlug } : {}),
      ...(caller.featureSlug ? { "x-feature-slug": caller.featureSlug } : {}),
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("cloudflare-r2 key not configured for this organization");
    }
    const error = await response.text();
    throw new Error(`Failed to fetch cloudflare-r2 key: ${error}`);
  }

  const data = (await response.json()) as { key: string; keySource: "platform" | "org" };
  return { key: data.key, keySource: data.keySource };
}
