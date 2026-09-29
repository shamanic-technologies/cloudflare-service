CREATE TABLE "bot_traffic_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_tag" text NOT NULL,
	"host" text NOT NULL,
	"day" date NOT NULL,
	"query" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_traffic_daily" (
	"host" text NOT NULL,
	"day" date NOT NULL,
	"category" text NOT NULL,
	"user_agent" text NOT NULL,
	"bot_name" text NOT NULL,
	"requests" integer NOT NULL,
	"capture_id" uuid NOT NULL,
	"rebuilt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bot_traffic_captures_host_day_sha_unique" ON "bot_traffic_captures" USING btree ("host","day","payload_sha256");--> statement-breakpoint
CREATE INDEX "bot_traffic_captures_host_day_idx" ON "bot_traffic_captures" USING btree ("host","day");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_traffic_daily_host_day_cat_ua_unique" ON "bot_traffic_daily" USING btree ("host","day","category","user_agent");--> statement-breakpoint
CREATE INDEX "bot_traffic_daily_host_day_idx" ON "bot_traffic_daily" USING btree ("host","day");--> statement-breakpoint
-- Gold: requests per (host, day, verified-bot category), rebuildable from silver.
CREATE VIEW "bot_traffic_daily_by_category" AS
SELECT "host", "day", "category", SUM("requests")::integer AS "requests", COUNT(DISTINCT "bot_name")::integer AS "bots"
FROM "bot_traffic_daily"
GROUP BY "host", "day", "category";
