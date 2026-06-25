import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

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
