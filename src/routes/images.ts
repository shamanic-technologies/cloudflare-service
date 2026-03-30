import { Router } from "express";
import sharp from "sharp";
import { serviceAuth } from "../middleware/auth.js";
import { decryptKey } from "../lib/key-client.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { getFromR2 } from "../lib/r2-client.js";
import type { R2Config } from "../lib/r2-client.js";
import type { AuthenticatedRequest } from "../types.js";
import type { Response } from "express";

const router = Router();

const ALLOWED_FIT = new Set(["cover", "contain", "fill", "inside", "outside"]);
const ALLOWED_FORMAT = new Set(["webp", "avif", "png", "jpeg"]);
const MAX_DIMENSION = 4096;

export function parsePositiveInt(value: string | undefined, max: number): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0 || n > max) return undefined;
  return n;
}

export function parseQuality(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || n > 100) return undefined;
  return n;
}

export function resolveContentType(format: string): string {
  switch (format) {
    case "webp": return "image/webp";
    case "avif": return "image/avif";
    case "png": return "image/png";
    case "jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

// GET /images/* — serve an image from R2 with optional resizing
router.get("/images/*", serviceAuth, async (req, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { orgId, userId, runId } = authReq;

  let childRun: { id: string };
  try {
    childRun = await createRun(
      { serviceName: "cloudflare-storage", taskName: "get-image" },
      { orgId, userId, runId }
    );
  } catch (err) {
    res.status(502).json({ error: "Failed to create run", reason: String(err) });
    return;
  }

  const identity = { orgId, userId };

  try {
    const r2Key = req.params[0];
    if (!r2Key) {
      res.status(400).json({ error: "Missing image key" });
      await updateRun(childRun.id, "failed", identity);
      return;
    }

    // Parse transform params
    const width = parsePositiveInt(req.query.w as string | undefined, MAX_DIMENSION);
    const height = parsePositiveInt(req.query.h as string | undefined, MAX_DIMENSION);
    const fitParam = req.query.fit as string | undefined;
    const fit = fitParam && ALLOWED_FIT.has(fitParam) ? fitParam as keyof sharp.FitEnum : undefined;
    const formatParam = req.query.format as string | undefined;
    const format = formatParam && ALLOWED_FORMAT.has(formatParam) ? formatParam : undefined;
    const quality = parseQuality(req.query.quality as string | undefined);

    // Resolve R2 credentials from key-service
    const callerContext = {
      callerMethod: "GET",
      callerPath: `/images/${r2Key}`,
      campaignId: authReq.campaignId,
      brandId: authReq.brandId,
      workflowSlug: authReq.workflowSlug,
      featureSlug: authReq.featureSlug,
    };

    const [accessKeyResult, secretKeyResult, accountIdResult, bucketNameResult, publicDomainResult] = await Promise.all([
      decryptKey("cloudflare-r2-access-key-id", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-secret-access-key", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-account-id", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-bucket-name", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-public-domain", orgId, userId, callerContext),
    ]);

    const r2Config: R2Config = {
      accessKeyId: accessKeyResult.key,
      secretAccessKey: secretKeyResult.key,
      accountId: accountIdResult.key,
      bucketName: bucketNameResult.key,
      publicDomain: publicDomainResult.key,
    };

    // Fetch from R2
    const object = await getFromR2(r2Config, r2Key);
    if (!object) {
      res.status(404).json({ error: "Image not found" });
      await updateRun(childRun.id, "failed", identity);
      return;
    }

    const needsTransform = !!(width || height || format);

    if (!needsTransform) {
      // Serve original
      res.setHeader("content-type", object.contentType);
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.send(object.body);
      await updateRun(childRun.id, "completed", identity);
      return;
    }

    // Apply transforms with sharp
    let pipeline = sharp(object.body);

    if (width || height) {
      pipeline = pipeline.resize({
        width,
        height,
        fit: fit || "inside",
        withoutEnlargement: true,
      });
    }

    const outputFormat = format || "jpeg";
    switch (outputFormat) {
      case "webp":
        pipeline = pipeline.webp({ quality: quality || 80 });
        break;
      case "avif":
        pipeline = pipeline.avif({ quality: quality || 50 });
        break;
      case "png":
        pipeline = pipeline.png();
        break;
      case "jpeg":
        pipeline = pipeline.jpeg({ quality: quality || 80 });
        break;
    }

    const transformed = await pipeline.toBuffer();

    res.setHeader("content-type", resolveContentType(outputFormat));
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.send(transformed);
    await updateRun(childRun.id, "completed", identity);
  } catch (err) {
    await updateRun(childRun.id, "failed", identity).catch(() => {});
    res.status(502).json({
      error: "Image processing failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
