/**
 * Cloudflare GraphQL Analytics client for verified-bot traffic.
 *
 * Token: CLOUDFLARE_ANALYTICS_API_TOKEN (Zone > Analytics > Read on the zone),
 * an env var on the box. Cloudflare GraphQL is free: no cost declaration.
 */
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Cloudflare's page cap for httpRequestsAdaptiveGroups. */
export const MAX_GROUPS_PER_QUERY = 10000;

export interface BotTrafficGroup {
  count: number;
  dimensions: { verifiedBotCategory: string; userAgent: string };
}

export interface DayQueryResult {
  query: string;
  groups: BotTrafficGroup[];
}

export function getAnalyticsToken(): string | undefined {
  return process.env.CLOUDFLARE_ANALYTICS_API_TOKEN || undefined;
}

async function cfFetch(token: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${CLOUDFLARE_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

export async function resolveZoneTag(token: string, zoneName: string): Promise<string> {
  const data = (await cfFetch(token, `/zones?name=${encodeURIComponent(zoneName)}`)) as {
    result?: Array<{ id: string }>;
  };
  const id = data.result?.[0]?.id;
  if (!id) throw new Error(`Cloudflare zone "${zoneName}" not found for this token`);
  return id;
}

export function buildDayQuery(zoneTag: string, host: string, day: string): string {
  // Every verified-bot request (verifiedBotCategory non-empty) on the host for
  // one UTC day, grouped by category and user agent.
  return (
    `{viewer{zones(filter:{zoneTag:${JSON.stringify(zoneTag)}}){` +
    `httpRequestsAdaptiveGroups(limit:${MAX_GROUPS_PER_QUERY},orderBy:[count_DESC],` +
    `filter:{date:${JSON.stringify(day)},clientRequestHTTPHost:${JSON.stringify(host)},verifiedBotCategory_neq:""})` +
    `{count dimensions{verifiedBotCategory userAgent}}}}}`
  );
}

export async function fetchDayGroups(
  token: string,
  zoneTag: string,
  host: string,
  day: string
): Promise<DayQueryResult> {
  const query = buildDayQuery(zoneTag, host, day);
  const data = (await cfFetch(token, "/graphql", { query })) as {
    data?: { viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: BotTrafficGroup[] }> } };
    errors?: Array<{ message: string }> | null;
  };
  if (data.errors && data.errors.length > 0) {
    throw new Error(`Cloudflare GraphQL error for ${day}: ${data.errors[0].message}`);
  }
  const groups = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
  if (!Array.isArray(groups)) {
    throw new Error(`Cloudflare GraphQL returned no httpRequestsAdaptiveGroups for ${day}`);
  }
  if (groups.length >= MAX_GROUPS_PER_QUERY) {
    // A full page means the day was truncated; storing it would under-count.
    throw new Error(`Cloudflare returned a full page (${groups.length} groups) for ${day}; refusing a truncated day`);
  }
  return { query, groups };
}
