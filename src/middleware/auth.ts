import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types.js";

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
  const brandId = req.headers["x-brand-id"] as string | undefined;
  const workflowName = req.headers["x-workflow-name"] as string | undefined;
  const featureSlug = req.headers["x-feature-slug"] as string | undefined;
  if (campaignId) authReq.campaignId = campaignId;
  if (brandId) authReq.brandId = brandId;
  if (workflowName) authReq.workflowName = workflowName;
  if (featureSlug) authReq.featureSlug = featureSlug;

  next();
}
