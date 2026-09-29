/**
 * Which UTC days the capture must (re)fetch. Pure, so it is unit-tested alone.
 *
 * - Cloudflare serves httpRequestsAdaptiveGroups for ~31 days
 *   (settings.notOlderThan = 2678400s). The oldest day it still serves in FULL
 *   is the one starting after now - 31d, so backfill starts there.
 * - A day is only captured once it is over AND Cloudflare has had
 *   FINAL_LAG_MS to land late events. A day is FINAL once a capture was seen
 *   after that point; final days are never fetched again by the scheduler.
 */
export const RETENTION_DAYS = 31;
export const FINAL_LAG_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, n: number): string {
  return toDay(new Date(dayStart(day).getTime() + n * DAY_MS));
}

/** First UTC day Cloudflare still serves in full at `now`. */
export function earliestCapturableDay(now: Date): string {
  return addDays(toDay(new Date(now.getTime() - RETENTION_DAYS * DAY_MS)), 1);
}

/** Instant after which a capture of `day` counts as final. */
export function finalAfter(day: string): Date {
  return new Date(dayStart(day).getTime() + DAY_MS + FINAL_LAG_MS);
}

export function isCapturable(day: string, now: Date): boolean {
  return day >= earliestCapturableDay(now) && finalAfter(day).getTime() <= now.getTime();
}

/**
 * @param lastSeenByDay latest bronze last_seen_at per day for the host.
 * @returns days, oldest first, that are capturable and not yet final.
 */
export function daysNeedingCapture(now: Date, lastSeenByDay: Map<string, Date>): string[] {
  const out: string[] = [];
  for (let day = earliestCapturableDay(now); isCapturable(day, now); day = addDays(day, 1)) {
    const seen = lastSeenByDay.get(day);
    if (!seen || seen.getTime() < finalAfter(day).getTime()) out.push(day);
  }
  return out;
}
