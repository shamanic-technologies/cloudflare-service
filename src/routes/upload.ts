import { Router } from "express";
import { randomUUID } from "crypto";
import { serviceAuth } from "../middleware/auth.js";
import { UploadRequestSchema } from "../schemas.js";
import { decryptKey } from "../lib/key-client.js";
import { createRun, updateRun, declareActualCost } from "../lib/runs-client.js";
import { authorizeCustomerBalance } from "../lib/billing-client.js";
import { uploadToR2 } from "../lib/r2-client.js";
import type { R2Config } from "../lib/r2-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { extractForwardHeaders } from "../lib/forward-headers.js";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { files } from "../db/schema.js";
import type { AuthenticatedRequest } from "../types.js";
import type { Response } from "express";

const router = Router();
const UPLOAD_COST_NAME = "cloudflare-r2-class-a-operation";

router.post("/upload", serviceAuth, async (req, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { orgId, userId, runId } = authReq;

  const sourceUrl: string = req.body?.sourceUrl || "(missing)";
  const logPrefix = `[cloudflare-service] [upload] [org=${orgId}]`;

  console.log(`${logPrefix} Starting upload — sourceUrl=${sourceUrl}, runId=${runId}`);

  // Create run
  let childRun: { id: string };
  try {
    childRun = await createRun(
      { serviceName: "cloudflare-storage", taskName: "upload" },
      { orgId, userId, runId }
    );
  } catch (err) {
    console.error(`${logPrefix} Failed to create run: ${err instanceof Error ? err.message : String(err)}`);
    res.status(502).json({ error: "Failed to create run", reason: String(err) });
    return;
  }

  const identity = { orgId, userId };
  const forwardHeaders = extractForwardHeaders(req.headers);

  try {
    // Validate body
    const parseResult = UploadRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const reason = parseResult.error.issues.map((i) => i.message).join(", ");
      console.warn(`${logPrefix} Invalid request body: ${reason}`);
      res.status(400).json({ error: "Invalid request body", reason });
      await updateRun(childRun.id, "failed", identity);
      return;
    }

    const { sourceUrl, folder, filename, contentType } = parseResult.data;

    traceEvent(childRun.id, { service: "cloudflare-service", event: "upload:start", detail: `sourceUrl=${sourceUrl}` }, req.headers);

    // Download file from sourceUrl
    console.log(`${logPrefix} Downloading from sourceUrl=${sourceUrl}`);
    const fetchStart = Date.now();
    const sourceResponse = await fetch(sourceUrl);
    const fetchMs = Date.now() - fetchStart;
    if (!sourceResponse.ok) {
      console.error(`${logPrefix} Source URL failed — status=${sourceResponse.status}, url=${sourceUrl}, fetchMs=${fetchMs}`);
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

    console.log(`${logPrefix} Downloaded ${fileBuffer.length} bytes in ${fetchMs}ms — contentType=${resolvedContentType}`);
    traceEvent(childRun.id, { service: "cloudflare-service", event: "upload:downloaded", data: { bytes: fileBuffer.length, fetchMs } }, req.headers);

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
      brandIds: authReq.brandIds,
      workflowSlug: authReq.workflowSlug,
      featureSlug: authReq.featureSlug,
    };

    console.log(`${logPrefix} Resolving R2 credentials from key-service`);
    const keyStart = Date.now();
    const [accessKeyResult, secretKeyResult, accountIdResult, bucketNameResult, publicDomainResult] = await Promise.all([
      decryptKey("cloudflare-r2-access-key-id", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-secret-access-key", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-account-id", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-bucket-name", orgId, userId, callerContext),
      decryptKey("cloudflare-r2-public-domain", orgId, userId, callerContext),
    ]);
    console.log(`${logPrefix} R2 credentials resolved in ${Date.now() - keyStart}ms`);

    const keySources = [
      accessKeyResult.keySource,
      secretKeyResult.keySource,
      accountIdResult.keySource,
      bucketNameResult.keySource,
      publicDomainResult.keySource,
    ];
    const uniqueSources = new Set(keySources);
    if (uniqueSources.size !== 1) {
      console.error(`${logPrefix} keySource mismatch across R2 credentials: ${keySources.join(",")}`);
      res.status(500).json({
        error: "Inconsistent keySource across R2 credentials",
        reason: keySources.join(","),
      });
      await updateRun(childRun.id, "failed", identity);
      return;
    }
    const costSource = keySources[0];

    // Platform branch: authorize via billing-service. Org branch: skip.
    if (costSource === "platform") {
      console.log(`${logPrefix} Authorizing platform cost ${UPLOAD_COST_NAME} qty=1`);
      const authz = await authorizeCustomerBalance({
        orgId,
        userId,
        runId: childRun.id,
        items: [{ costName: UPLOAD_COST_NAME, quantity: 1 }],
        forwardHeaders,
      });

      if (!authz.sufficient) {
        console.warn(
          `${logPrefix} Insufficient balance — balance_cents=${authz.balance_cents} required_cents=${authz.required_cents}`
        );
        res.status(402).json({
          error: "Insufficient credit balance",
          reason: `balance=${authz.balance_cents} required=${authz.required_cents}`,
        });
        await updateRun(childRun.id, "failed", identity);
        return;
      }
      console.log(
        `${logPrefix} Authorize sufficient=true balance_cents=${authz.balance_cents} required_cents=${authz.required_cents}`
      );
    }

    const r2Config: R2Config = {
      accessKeyId: accessKeyResult.key,
      secretAccessKey: secretKeyResult.key,
      accountId: accountIdResult.key,
      bucketName: bucketNameResult.key,
      publicDomain: publicDomainResult.key,
    };

    // Upload to R2
    console.log(`${logPrefix} Uploading to R2 — key=${r2Key}, size=${fileBuffer.length}`);
    const r2Start = Date.now();
    const publicUrl = await uploadToR2(
      r2Config,
      r2Key,
      fileBuffer,
      resolvedContentType
    );
    console.log(`${logPrefix} R2 upload completed in ${Date.now() - r2Start}ms — url=${publicUrl}`);
    traceEvent(childRun.id, { service: "cloudflare-service", event: "upload:r2-complete", data: { r2Key, uploadMs: Date.now() - r2Start } }, req.headers);

    // Store metadata (upsert: concurrent uploads of the same r2Key return the existing record)
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
      .onConflictDoUpdate({
        target: files.r2Key,
        set: { sourceUrl },
      })
      .returning();

    // Declare cost to runs-service (both platform and org). Quantity = 1 PUT.
    await declareActualCost(
      childRun.id,
      { costName: UPLOAD_COST_NAME, costSource, quantity: 1 },
      identity,
      forwardHeaders
    );

    await updateRun(childRun.id, "completed", identity);

    console.log(`${logPrefix} Upload complete — id=${record.id}, url=${publicUrl}`);
    traceEvent(childRun.id, { service: "cloudflare-service", event: "upload:complete", data: { fileId: record.id, sizeBytes: fileBuffer.length } }, req.headers);

    res.json({
      id: record.id,
      url: record.publicUrl,
      size: record.sizeBytes,
      contentType: record.contentType,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errStack = err instanceof Error ? err.stack : undefined;
    console.error(`${logPrefix} Upload failed — sourceUrl=${sourceUrl}, error=${errMsg}`, errStack ? `\n${errStack}` : "");
    traceEvent(childRun.id, { service: "cloudflare-service", event: "upload:error", level: "error", detail: errMsg }, req.headers);
    await updateRun(childRun.id, "failed", identity).catch(() => {});
    res.status(502).json({
      error: "Upload failed",
      reason: errMsg,
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
