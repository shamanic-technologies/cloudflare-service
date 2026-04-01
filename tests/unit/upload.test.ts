import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/auth.js";

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-child-123" }),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "mock-key", keySource: "platform" }),
}));

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadToR2: vi.fn().mockResolvedValue("https://storage.mcpfactory.org/videos/test.mp4"),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "00000000-0000-0000-0000-000000000099",
            publicUrl: "https://storage.mcpfactory.org/videos/test.mp4",
            sizeBytes: 1024,
            contentType: "video/mp4",
          },
        ]),
      }),
    }),
  },
}));

import uploadRouter from "../../src/routes/upload.js";
import { createRun, updateRun } from "../../src/lib/runs-client.js";
import { uploadToR2 } from "../../src/lib/r2-client.js";

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

  it("uploads successfully with all fields", async () => {
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
    expect(res.body.url).toBe("https://storage.mcpfactory.org/videos/test.mp4");
    expect(res.body.contentType).toBe("video/mp4");
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "completed", expect.any(Object));
  });

  it("returns 502 and logs when R2 upload fails", async () => {
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Upload failed"),
      expect.stringContaining("R2 PutObject timeout")
    );
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));

    errorSpy.mockRestore();
  });

  it("returns 502 and logs when key-service fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse()) as never;
    const { decryptKey } = await import("../../src/lib/key-client.js");
    vi.mocked(decryptKey).mockRejectedValueOnce(new Error("key-service unreachable"));

    const errorSpy = vi.spyOn(console, "error");

    const app = createApp();
    const res = await request(app).post("/upload").set(authHeaders).send({
      sourceUrl: "https://example.com/image.png",
    });

    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("key-service unreachable");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Upload failed"),
      expect.stringContaining("key-service unreachable")
    );

    errorSpy.mockRestore();
  });
});
