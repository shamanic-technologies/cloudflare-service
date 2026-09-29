import { Router } from "express";
import { z } from "zod";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { botTrafficCaptures, botTrafficDaily } from "../db/schema.js";
import { BOT_TRAFFIC_HOST, runBotTrafficCapture } from "../lib/bot-traffic/capture.js";
import { addDays, toDay } from "../lib/bot-traffic/days.js";

/**
 * Staff-only reads of verified-bot traffic (Cloudflare) on distribute.you.
 * Auth = the service API key (apiKeyAuth, global); no org identity.
 */
const router = Router();

/** AI categories first, in the order a reader cares about them. */
export const AI_CATEGORIES = ["AI Assistant", "AI Search", "AI Crawler"] as const;
const MAX_WINDOW_DAYS = 400;

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const DailyQuerySchema = z.object({
  from: dayString.optional(),
  to: dayString.optional(),
  categories: z.string().optional(),
  topBots: z.coerce.number().int().min(0).max(50).optional(),
});

export function orderCategories(totals: Map<string, number>): string[] {
  const ai = AI_CATEGORIES.filter((c) => totals.has(c));
  const rest = [...totals.keys()]
    .filter((c) => !(AI_CATEGORIES as readonly string[]).includes(c))
    .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b));
  return [...ai, ...rest];
}

router.get("/internal/bot-traffic/daily", async (req, res) => {
  const parsed = DailyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    return;
  }
  const to = parsed.data.to ?? addDays(toDay(new Date()), -1);
  const from = parsed.data.from ?? addDays(to, -29);
  if (from > to) {
    res.status(400).json({ error: "from must be <= to" });
    return;
  }
  if (addDays(from, MAX_WINDOW_DAYS) <= to) {
    res.status(400).json({ error: `window must be at most ${MAX_WINDOW_DAYS} days` });
    return;
  }
  const categoryFilter = parsed.data.categories
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const topBots = parsed.data.topBots ?? 10;

  try {
    const capturedRows = await db
      .selectDistinct({ day: botTrafficCaptures.day })
      .from(botTrafficCaptures)
      .where(and(eq(botTrafficCaptures.host, BOT_TRAFFIC_HOST), gte(botTrafficCaptures.day, from), lte(botTrafficCaptures.day, to)));
    const captured = new Set(capturedRows.map((r) => r.day));

    // Gold view: requests per (day, category).
    const series = (await db.execute(sql`
      SELECT "day"::text AS day, "category", "requests"
      FROM "bot_traffic_daily_by_category"
      WHERE "host" = ${BOT_TRAFFIC_HOST} AND "day" >= ${from} AND "day" <= ${to}
    `)) as unknown as Array<{ day: string; category: string; requests: number }>;

    const bots = await db
      .select({
        category: botTrafficDaily.category,
        botName: botTrafficDaily.botName,
        requests: sql<number>`sum(${botTrafficDaily.requests})::integer`,
      })
      .from(botTrafficDaily)
      .where(and(eq(botTrafficDaily.host, BOT_TRAFFIC_HOST), gte(botTrafficDaily.day, from), lte(botTrafficDaily.day, to)))
      .groupBy(botTrafficDaily.category, botTrafficDaily.botName)
      .orderBy(desc(sql`sum(${botTrafficDaily.requests})`), botTrafficDaily.botName);

    const keep = (c: string) => !categoryFilter || categoryFilter.includes(c);
    const totals = new Map<string, number>();
    const byDay = new Map<string, Record<string, number>>();
    for (const r of series) {
      if (!keep(r.category)) continue;
      totals.set(r.category, (totals.get(r.category) ?? 0) + Number(r.requests));
      const d = byDay.get(r.day) ?? {};
      d[r.category] = Number(r.requests);
      byDay.set(r.day, d);
    }
    // A requested category with no traffic in the window still gets a column.
    for (const c of categoryFilter ?? AI_CATEGORIES) if (!totals.has(c)) totals.set(c, 0);
    const categories = orderCategories(totals);

    const days = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      if (!captured.has(day)) {
        // Not captured (before the capture started, outside Cloudflare's
        // retention, or not final yet): null, never 0.
        days.push({ date: day, captured: false, requests: null });
        continue;
      }
      const counts = byDay.get(day) ?? {};
      days.push({
        date: day,
        captured: true,
        requests: Object.fromEntries(categories.map((c) => [c, counts[c] ?? 0])),
      });
    }

    res.json({
      host: BOT_TRAFFIC_HOST,
      from,
      to,
      categories,
      days,
      totals: categories.map((category) => ({
        category,
        requests: totals.get(category) ?? 0,
        topBots: bots
          .filter((b) => b.category === category)
          .slice(0, topBots)
          .map((b) => ({ botName: b.botName, requests: Number(b.requests) })),
      })),
    });
  } catch (err) {
    console.error("[bot-traffic] daily read failed:", err);
    res.status(500).json({ error: "Failed to read bot traffic", reason: String(err) });
  }
});

export const CaptureBodySchema = z.object({
  days: z.array(dayString).max(40).optional(),
});

/** Manual trigger: runs the same mutex-guarded capture as the scheduler. */
router.post("/internal/bot-traffic/capture", async (req, res) => {
  const parsed = CaptureBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const result = await runBotTrafficCapture({ forceDays: parsed.data.days });
  res.status(result.failed.length > 0 ? 502 : 200).json(result);
});

export default router;
