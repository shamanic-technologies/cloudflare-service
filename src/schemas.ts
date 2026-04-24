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

export const UploadRequestSchema = z.object({
  sourceUrl: z.string().url().openapi({ description: "URL to download the file from" }),
  folder: z.string().optional().openapi({ description: "R2 key prefix/folder" }),
  filename: z.string().optional().openapi({ description: "Desired filename" }),
  contentType: z.string().optional().openapi({ description: "MIME type" }),
}).openapi("UploadRequest");

export const UploadResponseSchema = z.object({
  id: z.string().uuid().openapi({ description: "File record UUID" }),
  url: z.string().url().openapi({ description: "Permanent public URL" }),
  size: z.number().int().openapi({ description: "File size in bytes" }),
  contentType: z.string().openapi({ description: "MIME type" }),
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

// --- Transfer Brand (internal) ---

export const TransferBrandRequestSchema = z.object({
  brandId: z.string().uuid().openapi({ description: "Brand UUID to transfer" }),
  sourceOrgId: z.string().uuid().openapi({ description: "Current org UUID" }),
  targetOrgId: z.string().uuid().openapi({ description: "Destination org UUID" }),
}).openapi("TransferBrandRequest");

export const TransferBrandResponseSchema = z.object({
  updatedTables: z.array(
    z.object({
      tableName: z.string(),
      count: z.number().int(),
    })
  ),
}).openapi("TransferBrandResponse");

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer brand ownership between orgs",
  description: "Re-assigns all solo-brand file rows from sourceOrgId to targetOrgId. Skips co-branding rows.",
  security: [{ [ApiKeyHeader.name]: [] }],
  request: {
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Transfer completed",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Invalid request",
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
