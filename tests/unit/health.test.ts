import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/auth.js";
import healthRouter from "../../src/routes/health.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use(healthRouter);
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_SERVICE_API_KEY = "test-api-key";
  });

  it("returns ok without auth", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      service: "cloudflare-storage-service",
    });
  });
});
