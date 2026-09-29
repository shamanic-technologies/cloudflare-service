import * as Sentry from "@sentry/node";
import { runBotTrafficCapture } from "./capture.js";

/**
 * THE bound on capture latency: yesterday is captured on the first tick after
 * 02:00 UTC (FINAL_LAG_MS), i.e. by 03:00 UTC at the latest. In-process on
 * purpose — a GitHub cron declares a cadence it does not deliver.
 */
export const BOT_TRAFFIC_INTERVAL_MS = 60 * 60 * 1000;

async function tick(trigger: string): Promise<void> {
  try {
    const r = await runBotTrafficCapture();
    const days = r.captured.map((c) => `${c.day}:${c.requests}`).join(",") || "none";
    console.log(
      `[bot-traffic] ${trigger} ${r.status}${r.reason ? ` (${r.reason})` : ""} captured=${days} failed=${r.failed.length}`
    );
    for (const f of r.failed) console.error(`[bot-traffic] capture failed for ${f.day}: ${f.error}`);
    if (r.status === "skipped" && r.reason?.includes("not set")) {
      Sentry.captureMessage(`[bot-traffic] ${r.reason}: verified-bot traffic is NOT being captured`, "error");
    }
  } catch (err) {
    console.error(`[bot-traffic] ${trigger} tick crashed:`, err);
    Sentry.captureException(err, { tags: { job: "bot-traffic-capture" } });
  }
}

/** Arm after listen + migrations: one immediate run (backfill), then hourly. */
export function startBotTrafficScheduler(): NodeJS.Timeout {
  void tick("boot");
  return setInterval(() => void tick("interval"), BOT_TRAFFIC_INTERVAL_MS);
}
