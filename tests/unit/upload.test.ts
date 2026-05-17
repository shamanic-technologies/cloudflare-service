import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/auth.js";

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-child-123" }),
  updateRun: vi.fn().mockResolvedValue(undefined),
  declareActualCost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "mock-key", keySource: "platform" }),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCustomerBalance: vi.fn().mockResolvedValue({
    sufficient: true,
    balance_cents: "1000.0000",
    required_cents: "0.0009",
  }),
}));

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadToR2: vi.fn().mockResolvedValue("https://storage.mcpfactory.org/videos/test.mp4"),
}));

vi.mock("../../src/db/index.js", () => {
  const record = {
    id: "00000000-0000-0000-0000-000000000099",
    publicUrl: "https://storage.mcpfactory.org/videos/test.mp4",
    sizeBytes: 1024,
    contentType: "video/mp4",
  };
  return {
    db: {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
          returning: vi.fn().mockResolvedValue([record]),
        }),
      }),
    },
  };
});

import uploadRouter from "../../src/routes/upload.js";
import { createRun, updateRun, declareActualCost } from "../../src/lib/runs-client.js";
import { authorizeCustomerBalance } from "../../src/lib/billing-client.js";
import { decryptKey } from "../../src/lib/key-client.js";
import { uploadToR2 } from "../../src/lib/r2-client.js";
import { db } from "../../src/db/index.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use(uploadRouter);
  return app;
}

const authHeaders = {
  "X-Api-Key": "test-api-key",
  "x-org-id": "00000000-0000-0000-0000-000000000001",
  "x-user-id": "00000000-0000-0000-0000-000000000002",
  "x-run-id": "parent-run-123",
};

function mockFetchResponse(overrides: Partial<{ ok: boolean; status: number; contentType: string; body: ArrayBuffer }> = {}) {
  const { ok = true, status = 200, contentType = "video/mp4", body = new ArrayBuffer(1024) } = overrides;
  return {
    ok,
    status,
    headers: { get: (_name: string) => contentType },
    arrayBuffer: () => Promise.resolve(body),
  };
}

describe("POST /upload", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_SERVICE_API_KEY = "test-api-key";
    vi.mocked(decryptKey).mockResolvedValue({ key: "mock-key", keySource: "platform" });
    vi.mocked(authorizeCustomerBalance).mockResolvedValue({
      sufficient: true,
      balance_cents: "1000.0000",
      required_cents: "0.0009",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 400 for invalid body", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/upload")
      .set(authHeaders)
      .send({ sourceUrl: "not-a-url" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("returns 502 when source URL fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ ok: false, status: 404 })) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
    });

    expect(res.status).toBe(502);
    expect(res.body.reason).toContain("404");
  });

  it("returns 502 when runs-service is unavailable", async () => {
    vi.mocked(createRun).mockRejectedValueOnce(new Error("runs-service down"));

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to create run");
  });

  it("platform: authorizes, uploads, declares actual cost, marks run completed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
      folder: "videos",
      filename: "test.mp4",
      contentType: "video/mp4",
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("00000000-0000-0000-0000-000000000099");
    expect(authorizeCustomerBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "00000000-0000-0000-0000-000000000001",
        userId: "00000000-0000-0000-0000-000000000002",
        runId: "run-child-123",
        items: [{ costName: "cloudflare-r2-class-a-operation", quantity: 1 }],
      })
    );
    expect(uploadToR2).toHaveBeenCalled();
    expect(declareActualCost).toHaveBeenCalledWith(
      "run-child-123",
      { costName: "cloudflare-r2-class-a-operation", costSource: "platform", quantity: 1 },
      expect.any(Object),
      expect.any(Object)
    );
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "completed", expect.any(Object));
  });

  it("platform sufficient=false: returns 402, skips R2 PUT, no cost row, run failed", async () => {
    vi.mocked(authorizeCustomerBalance).mockResolvedValue({
      sufficient: false,
      balance_cents: "0.0000",
      required_cents: "0.0009",
    });
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
    });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Insufficient credit balance");
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("platform billing non-2xx: returns 502, no R2 PUT, no cost row, run failed", async () => {
    vi.mocked(authorizeCustomerBalance).mockRejectedValueOnce(
      new Error("billing-service authorize failed: status=500 body=internal")
    );
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Upload failed");
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("org: skips authorize, uploads, declares actual cost w/ costSource=org", async () => {
    vi.mocked(decryptKey).mockResolvedValue({ key: "mock-key", keySource: "org" });
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
    });

    expect(res.status).toBe(200);
    expect(authorizeCustomerBalance).not.toHaveBeenCalled();
    expect(uploadToR2).toHaveBeenCalled();
    expect(declareActualCost).toHaveBeenCalledWith(
      "run-child-123",
      { costName: "cloudflare-r2-class-a-operation", costSource: "org", quantity: 1 },
      expect.any(Object),
      expect.any(Object)
    );
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "completed", expect.any(Object));
  });

  it("keySource mismatch across 5 decryptKey calls: 500, no R2 PUT, no cost row, run failed", async () => {
    vi.mocked(decryptKey)
      .mockResolvedValueOnce({ key: "k1", keySource: "platform" })
      .mockResolvedValueOnce({ key: "k2", keySource: "org" })
      .mockResolvedValueOnce({ key: "k3", keySource: "platform" })
      .mockResolvedValueOnce({ key: "k4", keySource: "platform" })
      .mockResolvedValueOnce({ key: "k5", keySource: "platform" });
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Inconsistent keySource across R2 credentials");
    expect(authorizeCustomerBalance).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("R2 fails after platform authorize success: 502, no cost row, run failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;
    vi.mocked(uploadToR2).mockRejectedValueOnce(new Error("R2 PutObject timeout"));

    const errorSpy = vi.spyOn(console, "error");

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/image.png",
      folder: "images",
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Upload failed");
    expect(res.body.reason).toBe("R2 PutObject timeout");
    expect(authorizeCustomerBalance).toHaveBeenCalled();
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));

    errorSpy.mockRestore();
  });

  it("returns 200 on duplicate r2_key via upsert", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/video.mp4",
      folder: "videos",
      filename: "test.mp4",
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("00000000-0000-0000-0000-000000000099");

    const insertMock = vi.mocked(db.insert);
    const valuesMock = insertMock.mock.results[0]?.value.values;
    const onConflictMock = valuesMock.mock.results[0]?.value.onConflictDoUpdate;
    expect(onConflictMock).toHaveBeenCalled();
  });

  it("returns 502 and logs when key-service fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;
    vi.mocked(decryptKey).mockRejectedValueOnce(new Error("key-service unreachable"));

    const errorSpy = vi.spyOn(console, "error");

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/image.png",
    });

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("key-service unreachable");

    errorSpy.mockRestore();
  });

  it("forwards x-campaign-id / x-brand-id / x-workflow-slug to billing + runs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;

    const app = createApp();
    await request(app)
      .post("/upload")
      .set({
        ...authHeaders,
        "x-campaign-id": "camp-9",
        "x-brand-id": "brand-9",
        "x-workflow-slug": "wf-9",
      })
      .send({ sourceUrl: "https://example.com/video.mp4" });

    expect(authorizeCustomerBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        forwardHeaders: expect.objectContaining({
          "x-campaign-id": "camp-9",
          "x-brand-id": "brand-9",
          "x-workflow-slug": "wf-9",
        }),
      })
    );
    expect(declareActualCost).toHaveBeenCalledWith(
      "run-child-123",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        "x-campaign-id": "camp-9",
        "x-brand-id": "brand-9",
        "x-workflow-slug": "wf-9",
      })
    );
  });
});
