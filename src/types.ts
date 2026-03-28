import type { Request } from "express";

export interface AuthenticatedRequest extends Request {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}
