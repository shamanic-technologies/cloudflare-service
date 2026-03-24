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
  deleteFromR2: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/db/index.js", () => {
  const findFirst = vi.fn();
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      query: {
        files: {
          findFirst,
        },
      },
      delete: vi.fn().mockReturnValue({
        where: deleteWhere,
      }),
    },
  };
});

import filesRouter from "../../src/routes/files.js";
import { createRun, updateRun } from "../../src/lib/runs-client.js";
import { db } from "../../src/db/index.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use(filesRouter);
  return app;
}

const headers = {
  "X-Api-Key": "test-api-key",
  "x-org-id": "00000000-0000-0000-0000-000000000001",
  "x-user-id": "00000000-0000-0000-0000-000000000002",
  "x-run-id": "parent-run-123",
};

const mockFile = {
  id: "00000000-0000-0000-0000-000000000099",
  publicUrl: "https://storage.mcpfactory.org/videos/test.mp4",
  folder: "videos",
  filename: "test.mp4",
  contentType: "video/mp4",
  sizeBytes: 1024,
  orgId: "00000000-0000-0000-0000-000000000001",
  r2Key: "videos/test.mp4",
  createdAt: new Date("2026-03-24T10:00:00Z"),
};

describe("GET /files/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_STORAGE_SERVICE_API_KEY = "test-api-key";
  });

  it("returns file metadata", async () => {
    vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(mockFile as never);

    const app = createApp();
    const res = await request(app)
      .get(`/files/${mockFile.id}`)
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(mockFile.id);
    expect(res.body.url).toBe(mockFile.publicUrl);
    expect(res.body.folder).toBe("videos");
    expect(res.body.filename).toBe("test.mp4");
  });

  it("returns 404 for missing file", async () => {
    vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(undefined as never);

    const app = createApp();
    const res = await request(app)
      .get("/files/00000000-0000-0000-0000-000000000099")
      .set(headers);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("File not found");
  });

  it("returns 502 when runs-service is down", async () => {
    vi.mocked(createRun).mockRejectedValueOnce(new Error("runs-service down"));

    const app = createApp();
    const res = await request(app)
      .get("/files/00000000-0000-0000-0000-000000000099")
      .set(headers);

    expect(res.status).toBe(502);
  });
});

describe("DELETE /files/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_STORAGE_SERVICE_API_KEY = "test-api-key";
  });

  it("deletes file and returns 204", async () => {
    vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(mockFile as never);

    const app = createApp();
    const res = await request(app)
      .delete(`/files/${mockFile.id}`)
      .set(headers);

    expect(res.status).toBe(204);
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "completed", expect.any(Object));
  });

  it("returns 404 for missing file", async () => {
    vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(undefined as never);

    const app = createApp();
    const res = await request(app)
      .delete("/files/00000000-0000-0000-0000-000000000099")
      .set(headers);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("File not found");
  });
});
