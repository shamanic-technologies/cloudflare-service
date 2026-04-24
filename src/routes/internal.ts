import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { TransferBrandRequestSchema } from "../schemas.js";
import { db } from "../db/index.js";
import { files } from "../db/schema.js";
import type { Response, Request } from "express";

const router = Router();

router.post("/internal/transfer-brand", async (req: Request, res: Response) => {
  const parseResult = TransferBrandRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    const reason = parseResult.error.issues.map((i) => i.message).join(", ");
    res.status(400).json({ error: "Invalid request body", reason });
    return;
  }

  const { brandId, sourceOrgId, targetOrgId } = parseResult.data;
  const logPrefix = `[cloudflare-service] [transfer-brand]`;

  console.log(`${logPrefix} Transferring brand=${brandId} from org=${sourceOrgId} to org=${targetOrgId}`);

  try {
    // Update rows where org_id = sourceOrgId AND brand_ids contains exactly one element which is brandId
    const result = await db
      .update(files)
      .set({ orgId: targetOrgId })
      .where(
        and(
          eq(files.orgId, sourceOrgId),
          sql`${files.brandIds} = ARRAY[${brandId}]::text[]`
        )
      );

    const rowCount = result.rowCount ?? 0;

    console.log(`${logPrefix} Updated ${rowCount} rows in files table`);

    res.json({
      updatedTables: [{ tableName: "files", count: rowCount }],
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`${logPrefix} Transfer failed: ${errMsg}`);
    res.status(500).json({ error: "Transfer failed", reason: errMsg });
  }
});

export default router;
