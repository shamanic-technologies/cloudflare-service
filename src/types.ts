import type { Request } from "express";

export interface AuthenticatedRequest extends Request {
  orgId: string;
  userId: string;
  runId: string;
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
  audienceId?: string;
}

// Platform/internal callers: service auth only, no org/user/run identity.
export interface PlatformRequest extends Request {
  serviceName: string;
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
  audienceId?: string;
}
