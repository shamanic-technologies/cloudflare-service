import { createHash } from "crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import * as Sentry from "@sentry/node";
import { db } from "../../db/index.js";
import { botTrafficCaptures, botTrafficDaily } from "../../db/schema.js";
import { deriveBotName } from "./bot-name.js";
import {
  fetchDayGroups,
  getAnalyticsToken,
  resolveZoneTag,
  type BotTrafficGroup,
} from "./cloudflare-graphql.js";
import { daysNeedingCapture, earliestCapturableDay, isCapturable } from "./days.js";

export const BOT_TRAFFIC_ZONE = process.env.BOT_TRAFFIC_ZONE || "distribute.you";
export const BOT_TRAFFIC_HOST = process.env.BOT_TRAFFIC_HOST || "distribute.you";

export interface SilverRow {
  category: string;
  userAgent: string;
  botName: string;
  requests: number;
}

/** Bronze payload -> silver rows. Pure; sums any repeated (category, UA) pair. */
export function toSilverRows(groups: BotTrafficGroup[]): SilverRow[] {
  const byKey = new Map<string, SilverRow>();
  for (const g of groups) {
    const category = g.dimensions?.verifiedBotCategory ?? "";
    const userAgent = g.dimensions?.userAgent ?? "";
    if (!category) continue;
    const key = `${category}\u0000${userAgent}`;
    const row = byKey.get(key);
    if (row) row.requests += g.count;
    else byKey.set(key, { category, userAgent, botName: deriveBotName(userAgent), requests: g.count });
  }
  return [...byKey.values()];
}

/** Order-independent hash, so the same rows in a different order dedup. */
export function payloadHash(groups: BotTrafficGroup[]): string {
  const canonical = groups
    .map((g) => [g.dimensions?.verifiedBotCategory ?? "", g.dimensions?.userAgent ?? "", g.count])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

let cachedZoneTag: string | null = null;

async function zoneTagFor(token: string): Promise<string> {
  if (!cachedZoneTag) cachedZoneTag = await resolveZoneTag(token, BOT_TRAFFIC_ZONE);
  return cachedZoneTag;
}

/**
 * Fetch one day from Cloudflare, append it to bronze (dedup on payload hash),
 * then rebuild that day's silver from its latest bronze capture in one
 * transaction. Re-running it for a day replaces the day, never adds to it.
 */
export async function captureDay(token: string, day: string): Promise<{ captureId: string; rows: number; requests: number }> {
  const zoneTag = await zoneTagFor(token);
  const { query, groups } = await fetchDayGroups(token, zoneTag, BOT_TRAFFIC_HOST, day);
  const now = new Date();

  return db.transaction(async (tx) => {
    await tx
      .insert(botTrafficCaptures)
      .values({
        zoneTag,
        host: BOT_TRAFFIC_HOST,
        day,
        query,
        payload: groups,
        payloadSha256: payloadHash(groups),
        rowCount: groups.length,
        capturedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [botTrafficCaptures.host, botTrafficCaptures.day, botTrafficCaptures.payloadSha256],
        set: { lastSeenAt: now },
      });

    const [latest] = await tx
      .select({ id: botTrafficCaptures.id, payload: botTrafficCaptures.payload })
      .from(botTrafficCaptures)
      .where(and(eq(botTrafficCaptures.host, BOT_TRAFFIC_HOST), eq(botTrafficCaptures.day, day)))
      .orderBy(desc(botTrafficCaptures.lastSeenAt), desc(botTrafficCaptures.capturedAt))
      .limit(1);

    const rows = toSilverRows(latest.payload as BotTrafficGroup[]);
    await tx
      .delete(botTrafficDaily)
      .where(and(eq(botTrafficDaily.host, BOT_TRAFFIC_HOST), eq(botTrafficDaily.day, day)));
    if (rows.length > 0) {
      await tx.insert(botTrafficDaily).values(
        rows.map((r) => ({ ...r, host: BOT_TRAFFIC_HOST, day, captureId: latest.id, rebuiltAt: now }))
      );
    }
    return { captureId: latest.id, rows: rows.length, requests: rows.reduce((s, r) => s + r.requests, 0) };
  });
}

export interface TickResult {
  status: "ran" | "skipped";
  reason?: string;
  captured: Array<{ day: string; rows: number; requests: number }>;
  failed: Array<{ day: string; error: string }>;
}

let running = false;

/**
 * The one entry point for every trigger (interval, boot, manual POST). The
 * mutex lives HERE so no two callers can capture concurrently.
 *
 * @param forceDays capture these days even if already final (manual re-capture).
 */
export async function runBotTrafficCapture(opts: { now?: Date; forceDays?: string[] } = {}): Promise<TickResult> {
  if (running) return { status: "skipped", reason: "already-running", captured: [], failed: [] };
  const token = getAnalyticsToken();
  if (!token) {
    return { status: "skipped", reason: "CLOUDFLARE_ANALYTICS_API_TOKEN not set", captured: [], failed: [] };
  }
  running = true;
  try {
    const now = opts.now ?? new Date();
    let days: string[];
    if (opts.forceDays && opts.forceDays.length > 0) {
      days = [...new Set(opts.forceDays)].filter((d) => isCapturable(d, now)).sort();
    } else {
      // Cheap probe: one grouped read; no Cloudflare call when everything is final.
      const seen = await db
        .select({ day: botTrafficCaptures.day, lastSeen: sql<string>`max(${botTrafficCaptures.lastSeenAt})` })
        .from(botTrafficCaptures)
        .where(and(eq(botTrafficCaptures.host, BOT_TRAFFIC_HOST), gte(botTrafficCaptures.day, earliestCapturableDay(now))))
        .groupBy(botTrafficCaptures.day);
      days = daysNeedingCapture(now, new Map(seen.map((s) => [s.day, new Date(s.lastSeen)])));
    }

    const result: TickResult = { status: "ran", captured: [], failed: [] };
    for (const day of days) {
      try {
        const r = await captureDay(token, day);
        result.captured.push({ day, rows: r.rows, requests: r.requests });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result.failed.push({ day, error });
        Sentry.captureException(err, { tags: { job: "bot-traffic-capture", day } });
      }
    }
    return result;
  } finally {
    running = false;
  }
}
