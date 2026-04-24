import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

export const files = pgTable("files", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull(),
  userId: uuid("user_id").notNull(),
  folder: text("folder"),
  filename: text("filename").notNull(),
  r2Key: text("r2_key").notNull().unique(),
  publicUrl: text("public_url").notNull(),
  sourceUrl: text("source_url"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  brandIds: text("brand_ids").array(),
  campaignId: uuid("campaign_id"),
  workflowSlug: text("workflow_slug"),
  featureSlug: text("feature_slug"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
