import { Router } from "express";
import { eq } from "drizzle-orm";
import { serviceAuth } from "../middleware/auth.js";
import { decryptKey } from "../lib/key-client.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { deleteFromR2 } from "../lib/r2-client.js";
import type { R2Config } from "../lib/r2-client.js";
import { db } from "../db/index.js";
import { files } from "../db/schema.js";
import type { AuthenticatedRequest } from "../types.js";
import type { Response } from "express";

const router = Router();

// GET /files/:id
router.get("/files/:id", serviceAuth, async (req, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { orgId, userId, runId } = authReq;

  let childRun: { id: string };
  try {
    childRun = await createRun(
      { serviceName: "cloudflare-storage", taskName: "get-file" },
      { orgId, userId, runId }
    );
  } catch (err) {
    res.status(502).json({ error: "Failed to create run", reason: String(err) });
    return;
  }

  try {
    const record = await db.query.files.findFirst({
      where: eq(files.id, req.params.id as string),
    });

    if (!record) {
      await updateRun(childRun.id, "failed", { orgId, userId });
      res.status(404).json({ error: "File not found" });
      return;
    }

    await updateRun(childRun.id, "completed", { orgId, userId });

    res.json({
      id: record.id,
      url: record.publicUrl,
      folder: record.folder,
      filename: record.filename,
      contentType: record.contentType,
      size: record.sizeBytes,
      orgId: record.orgId,
      createdAt: record.createdAt.toISOString(),
    });
  } catch (err) {
    await updateRun(childRun.id, "failed", { orgId, userId }).catch(() => {});
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /files/:id
router.delete("/files/:id", serviceAuth, async (req, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { orgId, userId, runId } = authReq;

  let childRun: { id: string };
  try {
    childRun = await createRun(
      { serviceName: "cloudflare-storage", taskName: "delete-file" },
      { orgId, userId, runId }
    );
  } catch (err) {
    res.status(502).json({ error: "Failed to create run", reason: String(err) });
    return;
  }

  try {
    const record = await db.query.files.findFirst({
      where: eq(files.id, req.params.id as string),
    });

    if (!record) {
      await updateRun(childRun.id, "failed", { orgId, userId });
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Resolve R2 credentials
    const callerContext = {
      callerMethod: "DELETE",
      callerPath: `/files/${req.params.id}`,
      campaignId: authReq.campaignId,
      brandIds: authReq.brandIds,
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

    // Delete from R2
    await deleteFromR2(r2Config, record.r2Key);

    // Delete metadata
    await db.delete(files).where(eq(files.id, req.params.id as string));

    await updateRun(childRun.id, "completed", { orgId, userId });
    res.status(204).send();
  } catch (err) {
    await updateRun(childRun.id, "failed", { orgId, userId }).catch(() => {});
    res.status(502).json({
      error: "Delete failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
