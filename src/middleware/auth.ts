import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest, PlatformRequest } from "../types.js";

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/health" || req.path === "/openapi.json") {
    next();
    return;
  }

  const API_KEY = process.env.CLOUDFLARE_SERVICE_API_KEY;
  const apiKey = req.headers["x-api-key"] as string | undefined;

  if (!API_KEY) {
    res.status(500).json({ error: "Server misconfiguration: API key not set" });
    return;
  }

  if (!apiKey || apiKey !== API_KEY) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }

  next();
}

export function serviceAuth(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest;
  const orgId = req.headers["x-org-id"] as string;
  const userId = req.headers["x-user-id"] as string;
  const runId = req.headers["x-run-id"] as string;

  if (!orgId) {
    res.status(400).json({ error: "x-org-id header required" });
    return;
  }
  if (!userId) {
    res.status(400).json({ error: "x-user-id header required" });
    return;
  }
  if (!runId) {
    res.status(400).json({ error: "x-run-id header required" });
    return;
  }

  authReq.orgId = orgId;
  authReq.userId = userId;
  authReq.runId = runId;

  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  const brandIds = rawBrandId
    ? rawBrandId.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const audienceId = req.headers["x-audience-id"] as string | undefined;
  if (campaignId) authReq.campaignId = campaignId;
  if (brandIds && brandIds.length > 0) authReq.brandIds = brandIds;
  if (workflowSlug) authReq.workflowSlug = workflowSlug;
  if (featureSlug) authReq.featureSlug = featureSlug;
  if (audienceId) authReq.audienceId = audienceId;

  next();
}

/**
 * Platform/internal auth: service API key (validated globally by apiKeyAuth) +
 * x-service-name. NO x-org-id / x-user-id / x-run-id. Used by service callers
 * that have no org/user/run identity (e.g. chat-service platform image gen).
 */
export function platformAuth(req: Request, res: Response, next: NextFunction): void {
  const platformReq = req as PlatformRequest;
  const serviceName = req.headers["x-service-name"] as string | undefined;

  if (!serviceName) {
    res.status(400).json({ error: "x-service-name header required" });
    return;
  }

  platformReq.serviceName = serviceName;

  const campaignId = req.headers["x-campaign-id"] as string | undefined;
  const rawBrandId = req.headers["x-brand-id"] as string | undefined;
  const brandIds = rawBrandId
    ? rawBrandId.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const workflowSlug = req.headers["x-workflow-slug"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  const audienceId = req.headers["x-audience-id"] as string | undefined;
  if (campaignId) platformReq.campaignId = campaignId;
  if (brandIds && brandIds.length > 0) platformReq.brandIds = brandIds;
  if (workflowSlug) platformReq.workflowSlug = workflowSlug;
  if (featureSlug) platformReq.featureSlug = featureSlug;
  if (audienceId) platformReq.audienceId = audienceId;

  next();
}
