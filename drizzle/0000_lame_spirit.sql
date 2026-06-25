CREATE TABLE IF NOT EXISTS "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"folder" text,
	"filename" text NOT NULL,
	"r2_key" text NOT NULL,
	"public_url" text NOT NULL,
	"source_url" text,
	"content_type" text,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "files_r2_key_unique" UNIQUE("r2_key")
);
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "org_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "user_id" DROP NOT NULL;
