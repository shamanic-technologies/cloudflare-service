import { Router } from "express";
import { randomUUID } from "crypto";
import { serviceAuth } from "../middleware/auth.js";
import { UploadRequestSchema } from "../schemas.js";
import { decryptKey } from "../lib/key-client.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { uploadToR2 } from "../lib/r2-client.js";
import type { R2Config } from "../lib/r2-client.js";
import { db } from "../db/index.js";
import { files } from "../db/schema.js";
import type { AuthenticatedRequest } from "../types.js";
import type { Response } from "express";

const router = Router();

router.post("/upload", serviceAuth, async (req, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { orgId, userId, runId } = authReq;

  // Create run
  let childRun: { id: string };
  try {
    childRun = await createRun(
      { serviceName: "cloudflare-storage", taskName: "upload" },
      { orgId, userId, runId }
    );
  } catch (err) {
    res.status(502).json({ error: "Failed to create run", reason: String(err) });
    return;
  }

  const identity = { orgId, userId };

  try {
    // Validate body
    const parseResult = UploadRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        reason: parseResult.error.issues.map((i) => i.message).join(", "),
      });
      await updateRun(childRun.id, "failed", identity);
      return;
    }

    const { sourceUrl, folder, filename, contentType } = parseResult.data;

    // Download file from sourceUrl
    const sourceResponse = await fetch(sourceUrl);
    if (!sourceResponse.ok) {
      res.status(502).json({
        error: "Upload failed",
        reason: `Source URL returned ${sourceResponse.status}`,
      });
      await updateRun(childRun.id, "failed", identity);
      return;
    }

    const fileBuffer = Buffer.from(await sourceResponse.arrayBuffer());
    const resolvedContentType =
      contentType ||
      sourceResponse.headers.get("content-type") ||
      "application/octet-stream";

    // Derive filename
    const resolvedFilename =
      filename || extractFilename(sourceUrl) || `${randomUUID()}`;

    // Build R2 key
    const r2Key = folder ? `${folder}/${resolvedFilename}` : resolvedFilename;

    // Resolve R2 credentials from key-service
    const callerContext = {
      callerMethod: "POST",
      callerPath: "/upload",
      campaignId: authReq.campaignId,
      brandId: authReq.brandId,
      workflowName: authReq.workflowName,
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

    // Upload to R2
    const publicUrl = await uploadToR2(
      r2Config,
      r2Key,
      fileBuffer,
      resolvedContentType
    );

    // Store metadata
    const [record] = await db
      .insert(files)
      .values({
        orgId,
        userId,
        folder: folder || null,
        filename: resolvedFilename,
        r2Key,
        publicUrl,
        sourceUrl,
        contentType: resolvedContentType,
        sizeBytes: fileBuffer.length,
      })
      .returning();

    await updateRun(childRun.id, "completed", identity);

    res.json({
      id: record.id,
      url: record.publicUrl,
      size: record.sizeBytes,
      contentType: record.contentType,
    });
  } catch (err) {
    await updateRun(childRun.id, "failed", identity).catch(() => {});
    res.status(502).json({
      error: "Upload failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

function extractFilename(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

export default router;
