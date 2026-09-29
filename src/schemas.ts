import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);
export const registry = new OpenAPIRegistry();

// --- Shared ---

const ApiKeyHeader = registry.registerComponent("securitySchemes", "ApiKeyAuth", {
  type: "apiKey",
  in: "header",
  name: "X-Api-Key",
});

const identityHeaders = {
  "x-org-id": z.string().uuid().openapi({ description: "Internal org UUID" }),
  "x-user-id": z.string().uuid().openapi({ description: "Internal user UUID" }),
  "x-run-id": z.string().openapi({ description: "Run ID from runs-service" }),
  "x-brand-id": z.string().optional().openapi({
    description: "Comma-separated list of brand UUIDs (e.g. uuid1,uuid2,uuid3)",
    example: "00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002",
  }),
};

const platformHeaders = {
  "x-service-name": z.string().openapi({
    description: "Internal caller service name",
    example: "chat-service",
  }),
  "x-campaign-id": z.string().optional().openapi({ description: "Optional campaign attribution" }),
  "x-brand-id": z.string().optional().openapi({
    description: "Optional comma-separated brand attribution",
    example: "00000000-0000-0000-0000-000000000001",
  }),
  "x-workflow-slug": z.string().optional().openapi({ description: "Optional workflow attribution" }),
  "x-feature-slug": z.string().optional().openapi({ description: "Optional feature attribution" }),
  "x-audience-id": z.string().optional().openapi({ description: "Optional audience attribution" }),
};

// --- Health ---

export const HealthResponseSchema = z.object({
  status: z.string().openapi({ example: "ok" }),
  service: z.string().openapi({ example: "cloudflare-storage-service" }),
}).openapi("HealthResponse");

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

// --- Upload ---

const optimizeForField = z.enum(["email"]).optional().openapi({
  description:
    "Optimise the stored object for a delivery target before writing it to R2. " +
    "Omit it and the upload is stored byte-for-byte as supplied. " +
    "'email' bounds the image to 1200x1200 (fit inside, never upscaled), bakes in EXIF " +
    "orientation, strips metadata, and re-encodes to JPEG (or PNG when the source has " +
    "transparency) so every mail client can draw it — never WebP or AVIF. Animated GIFs are " +
    "stored unchanged. The returned public URL stays a plain unauthenticated link, and the " +
    "returned filename extension follows the stored format.",
  example: "email",
});

export const UploadRequestSchema = z.object({
  sourceUrl: z.string().url().openapi({ description: "URL to download the file from" }),
  folder: z.string().optional().openapi({ description: "R2 key prefix/folder" }),
  filename: z.string().optional().openapi({ description: "Desired filename" }),
  contentType: z.string().optional().openapi({ description: "MIME type" }),
  optimizeFor: optimizeForField,
}).openapi("UploadRequest");

export const UploadBase64RequestSchema = z.object({
  contentBase64: z.string().openapi({
    description: "Base64-encoded file content. Data URL prefixes are accepted.",
  }),
  folder: z.string().optional().openapi({ description: "R2 key prefix/folder" }),
  filename: z.string().optional().openapi({ description: "Desired filename" }),
  contentType: z.string().optional().openapi({ description: "MIME type" }),
  optimizeFor: optimizeForField,
}).openapi("UploadBase64Request");

export const UploadResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: "File record UUID" }),
  url: z.string().url().openapi({ description: "Permanent public URL" }),
  size: z.number().int().openapi({ description: "File size in bytes" }),
  contentType: z.string().openapi({ description: "MIME type" }),
  optimizedFor: z.enum(["email"]).optional().openapi({
    description: "Present only when optimizeFor was requested and the stored bytes were re-encoded.",
  }),
  width: z.number().int().optional().openapi({
    description: "Stored image width in pixels. Present only when optimizeFor was requested.",
  }),
  height: z.number().int().optional().openapi({
    description: "Stored image height in pixels. Present only when optimizeFor was requested.",
  }),
}).openapi("UploadResponse");

export const ErrorResponseSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
}).openapi("ErrorResponse");

registry.registerPath({
  method: "post",
  path: "/upload",
  summary: "Upload a file to R2",
  description: "Downloads a file from a given URL and uploads it to Cloudflare R2",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    headers: z.object(identityHeaders),
    body: {
      content: { "application/json": { schema: UploadRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "File uploaded successfully",
      content: { "application/json": { schema: UploadResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upload failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/upload/base64",
  summary: "Upload base64 content to R2",
  description: "Decodes base64 file content from the request body and uploads it to Cloudflare R2",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    headers: z.object(identityHeaders),
    body: {
      content: { "application/json": { schema: UploadBase64RequestSchema } },
    },
  },
  responses: {
    200: {
      description: "File uploaded successfully",
      content: { "application/json": { schema: UploadResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upload failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/internal/upload/base64",
  summary: "Upload platform base64 content to R2",
  description: "Decodes base64 file content from an internal service caller and uploads it to Cloudflare R2 without org, user, or parent run identity.",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    headers: z.object(platformHeaders),
    body: {
      content: { "application/json": { schema: UploadBase64RequestSchema } },
    },
  },
  responses: {
    200: {
      description: "File uploaded successfully",
      content: { "application/json": { schema: UploadResponseSchema } },
    },
    400: {
      description: "Invalid request or missing x-service-name",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Invalid or missing service API key",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Upload failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Get File ---

export const FileResponseSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  folder: z.string().nullable(),
  filename: z.string(),
  contentType: z.string().nullable(),
  size: z.number().int().nullable(),
  orgId: z.string().uuid(),
  createdAt: z.string().datetime(),
}).openapi("FileResponse");

registry.registerPath({
  method: "get",
  path: "/files/{id}",
  summary: "Get file metadata",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    headers: z.object(identityHeaders),
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "File metadata",
      content: { "application/json": { schema: FileResponseSchema } },
    },
    404: {
      description: "File not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Get Image (with optional resizing) ---

registry.registerPath({
  method: "get",
  path: "/images/{key}",
  summary: "Serve an image from R2 with optional resizing",
  description: "Fetches an image from R2 by key. Supports on-the-fly resizing via query params: w (width), h (height), fit (cover|contain|fill|inside|outside), format (webp|avif|png|jpeg), quality (1-100).",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    headers: z.object(identityHeaders),
    params: z.object({ key: z.string().openapi({ description: "R2 object key (full path)" }) }),
    query: z.object({
      w: z.string().optional().openapi({ description: "Max width in pixels (1-4096)" }),
      h: z.string().optional().openapi({ description: "Max height in pixels (1-4096)" }),
      fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional().openapi({ description: "Resize fit mode" }),
      format: z.enum(["webp", "avif", "png", "jpeg"]).optional().openapi({ description: "Output format" }),
      quality: z.string().optional().openapi({ description: "Output quality (1-100)" }),
    }),
  },
  responses: {
    200: {
      description: "Image binary",
      content: { "image/*": { schema: z.string().openapi({ type: "string", format: "binary" }) } },
    },
    404: {
      description: "Image not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    502: {
      description: "Image processing failed",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Delete File ---

registry.registerPath({
  method: "delete",
  path: "/files/{id}",
  summary: "Delete a file",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    headers: z.object(identityHeaders),
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: { description: "File deleted successfully" },
    404: {
      description: "File not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// --- Verified-bot traffic (staff-only, Cloudflare GraphQL) ---

const BotTrafficDaySchema = z.object({
  date: z.string().openapi({ example: "2026-09-28" }),
  captured: z.boolean().openapi({
    description: "false = no capture for this day (before capture started, outside Cloudflare's ~31-day retention, or not final yet). requests is then null, never 0.",
  }),
  requests: z.record(z.number().int()).nullable().openapi({
    description: "Requests per verified-bot category for the day (every listed category present, 0 when none).",
    example: { "AI Assistant": 14, "AI Search": 165, "AI Crawler": 58 },
  }),
});

export const BotTrafficDailyResponseSchema = z.object({
  host: z.string().openapi({ example: "distribute.you" }),
  from: z.string(),
  to: z.string(),
  categories: z.array(z.string()).openapi({
    description: "AI Assistant, AI Search, AI Crawler first, then other verified-bot categories by volume.",
  }),
  days: z.array(BotTrafficDaySchema),
  totals: z.array(z.object({
    category: z.string(),
    requests: z.number().int(),
    topBots: z.array(z.object({
      botName: z.string().openapi({ example: "ChatGPT-User" }),
      requests: z.number().int(),
    })),
  })),
}).openapi("BotTrafficDailyResponse");

registry.registerPath({
  method: "get",
  path: "/internal/bot-traffic/daily",
  summary: "Daily verified-bot traffic on distribute.you, by category and top bots",
  description:
    "Staff-only. Cloudflare verified-bot requests on the distribute.you host, captured daily (hourly scheduler, a day is final once captured after 02:00 UTC the next day). 'AI Assistant' = fetched live to answer a user's question (ChatGPT-User, Claude-User, DuckAssistBot, Perplexity-User), 'AI Search' = AI search index, 'AI Crawler' = model training. Default window: the 30 days ending yesterday (UTC).",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    query: z.object({
      from: z.string().optional().openapi({ description: "First UTC day, YYYY-MM-DD (default: to - 29)" }),
      to: z.string().optional().openapi({ description: "Last UTC day, YYYY-MM-DD (default: yesterday)" }),
      categories: z.string().optional().openapi({ description: "Comma-separated category filter", example: "AI Assistant,AI Search,AI Crawler" }),
      topBots: z.string().optional().openapi({ description: "Top bots per category (0-50, default 10)" }),
    }),
  },
  responses: {
    200: { description: "Daily series", content: { "application/json": { schema: BotTrafficDailyResponseSchema } } },
    400: { description: "Invalid query", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export const BotTrafficCaptureResultSchema = z.object({
  status: z.enum(["ran", "skipped"]),
  reason: z.string().optional(),
  captured: z.array(z.object({ day: z.string(), rows: z.number().int(), requests: z.number().int() })),
  failed: z.array(z.object({ day: z.string(), error: z.string() })),
}).openapi("BotTrafficCaptureResult");

registry.registerPath({
  method: "post",
  path: "/internal/bot-traffic/capture",
  summary: "Run the verified-bot capture now (staff-only)",
  description:
    "Runs the same mutex-guarded capture as the hourly scheduler. Without body: captures every day still missing or not final. With days: re-captures those days (within Cloudflare's retention); a day is replaced, never added to.",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: z.object({ days: z.array(z.string()).optional().openapi({ example: ["2026-09-28"] }) }) } },
    },
  },
  responses: {
    200: { description: "Capture result", content: { "application/json": { schema: BotTrafficCaptureResultSchema } } },
    502: { description: "At least one day failed", content: { "application/json": { schema: BotTrafficCaptureResultSchema } } },
  },
});
