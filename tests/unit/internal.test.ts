import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/auth.js";

const mockWhere = vi.fn();

vi.mock("../../src/db/index.js", () => {
  return {
    db: {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: (...args: unknown[]) => mockWhere(...args),
        }),
      }),
    },
  };
});

import internalRouter from "../../src/routes/internal.js";
import { db } from "../../src/db/index.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use(internalRouter);
  return app;
}

const headers = {
  "X-Api-Key": "test-api-key",
};

const validBody = {
  brandId: "00000000-0000-0000-0000-000000000010",
  sourceOrgId: "00000000-0000-0000-0000-000000000001",
  targetOrgId: "00000000-0000-0000-0000-000000000002",
};

describe("POST /internal/transfer-brand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_SERVICE_API_KEY = "test-api-key";
    mockWhere.mockResolvedValue({ rowCount: 3 });
  });

  it("transfers solo-brand rows and returns count", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "files", count: 3 },
    ]);
  });

  it("returns 0 count when no matching rows (idempotent)", async () => {
    mockWhere.mockResolvedValue({ rowCount: 0 });

    const app = createApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([
      { tableName: "files", count: 0 },
    ]);
  });

  it("returns 400 for missing brandId", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ sourceOrgId: validBody.sourceOrgId, targetOrgId: validBody.targetOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("returns 400 for invalid UUID", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send({ ...validBody, brandId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("returns 401 without api key", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it("returns 500 when database fails", async () => {
    mockWhere.mockRejectedValue(new Error("connection refused"));

    const app = createApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set(headers)
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Transfer failed");
  });
});
