import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth, serviceAuth } from "../../src/middleware/auth.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);

  app.post("/test-service-auth", serviceAuth, (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

describe("apiKeyAuth middleware", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_STORAGE_SERVICE_API_KEY = "test-api-key";
  });

  it("rejects requests without API key", async () => {
    const app = createApp();
    const res = await request(app).post("/test-service-auth");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or missing API key");
  });

  it("rejects requests with wrong API key", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/test-service-auth")
      .set("X-Api-Key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("accepts requests with correct API key", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/test-service-auth")
      .set("X-Api-Key", "test-api-key")
      .set("x-org-id", "00000000-0000-0000-0000-000000000001")
      .set("x-user-id", "00000000-0000-0000-0000-000000000002")
      .set("x-run-id", "run-123");
    expect(res.status).toBe(200);
  });
});

describe("serviceAuth middleware", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_STORAGE_SERVICE_API_KEY = "test-api-key";
  });

  it("rejects missing x-org-id", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/test-service-auth")
      .set("X-Api-Key", "test-api-key");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-org-id header required");
  });

  it("rejects missing x-user-id", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/test-service-auth")
      .set("X-Api-Key", "test-api-key")
      .set("x-org-id", "00000000-0000-0000-0000-000000000001");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-user-id header required");
  });

  it("rejects missing x-run-id", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/test-service-auth")
      .set("X-Api-Key", "test-api-key")
      .set("x-org-id", "00000000-0000-0000-0000-000000000001")
      .set("x-user-id", "00000000-0000-0000-0000-000000000002");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-run-id header required");
  });
});
