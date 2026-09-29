import { pgTable, uuid, text, integer, timestamp, date, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const files = pgTable("files", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Nullable: platform/internal uploads (POST /internal/upload/base64) have no
  // org/user. Org uploads still always populate both.
  orgId: uuid("org_id"),
  userId: uuid("user_id"),
  folder: text("folder"),
  filename: text("filename").notNull(),
  r2Key: text("r2_key").notNull().unique(),
  publicUrl: text("public_url").notNull(),
  sourceUrl: text("source_url"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Verified-bot traffic (Cloudflare GraphQL Analytics) ---
//
// Cloudflare only serves ~31 days of httpRequestsAdaptiveGroups, so every day
// not captured here is lost. Layering:
//   bronze  bot_traffic_captures   one row per distinct Cloudflare answer for a
//                                   (host, date); append-only, deduped on the
//                                   payload hash so a re-capture that returns the
//                                   same rows adds nothing.
//   silver  bot_traffic_daily      (host, date, category, user agent) -> requests,
//                                   rebuilt for a day from that day's LATEST
//                                   bronze capture (delete + insert in one tx), so
//                                   a re-capture replaces the day, never adds to it.
//   gold    bot_traffic_daily_by_category (view, migration 0001) and the
//           GET /internal/bot-traffic/daily read.

export const botTrafficCaptures = pgTable(
  "bot_traffic_captures",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    zoneTag: text("zone_tag").notNull(),
    host: text("host").notNull(),
    day: date("day").notNull(),
    // The GraphQL query sent, verbatim, so a capture is reproducible.
    query: text("query").notNull(),
    // Raw httpRequestsAdaptiveGroups rows as Cloudflare returned them.
    payload: jsonb("payload").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    rowCount: integer("row_count").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    // Bumped when a later capture returns the byte-identical payload (deduped on
    // the hash). Finality and "latest capture" read this, not captured_at.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bot_traffic_captures_host_day_sha_unique").on(t.host, t.day, t.payloadSha256),
    index("bot_traffic_captures_host_day_idx").on(t.host, t.day),
  ]
);

export const botTrafficDaily = pgTable(
  "bot_traffic_daily",
  {
    host: text("host").notNull(),
    day: date("day").notNull(),
    category: text("category").notNull(),
    userAgent: text("user_agent").notNull(),
    // Derived from userAgent (deterministic parse, see lib/bot-traffic/bot-name.ts).
    botName: text("bot_name").notNull(),
    requests: integer("requests").notNull(),
    captureId: uuid("capture_id").notNull(),
    rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("bot_traffic_daily_host_day_cat_ua_unique").on(t.host, t.day, t.category, t.userAgent),
    index("bot_traffic_daily_host_day_idx").on(t.host, t.day),
  ]
);
