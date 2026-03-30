import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/auth.js";

const mockGetFromR2 = vi.fn();

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-child-123" }),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "mock-key", keySource: "platform" }),
}));

vi.mock("../../src/lib/r2-client.js", () => ({
  getFromR2: (...args: unknown[]) => mockGetFromR2(...args),
}));

import imagesRouter from "../../src/routes/images.js";
import { parsePositiveInt, parseQuality, resolveContentType } from "../../src/routes/images.js";
import { createRun, updateRun } from "../../src/lib/runs-client.js";

// 1x1 red PNG pixel
const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64"
);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(apiKeyAuth);
  app.use(imagesRouter);
  return app;
}

const authHeaders = {
  "X-Api-Key": "test-api-key",
  "x-org-id": "00000000-0000-0000-0000-000000000001",
  "x-user-id": "00000000-0000-0000-0000-000000000002",
  "x-run-id": "parent-run-123",
};

describe("parsePositiveInt", () => {
  it("parses valid number", () => {
    expect(parsePositiveInt("400", 4096)).toBe(400);
  });

  it("returns undefined for zero", () => {
    expect(parsePositiveInt("0", 4096)).toBeUndefined();
  });

  it("returns undefined for negative", () => {
    expect(parsePositiveInt("-10", 4096)).toBeUndefined();
  });

  it("returns undefined for over max", () => {
    expect(parsePositiveInt("9999", 4096)).toBeUndefined();
  });

  it("returns undefined for non-number", () => {
    expect(parsePositiveInt("abc", 4096)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(parsePositiveInt(undefined, 4096)).toBeUndefined();
  });
});

describe("parseQuality", () => {
  it("parses valid quality", () => {
    expect(parseQuality("80")).toBe(80);
  });

  it("returns undefined for 0", () => {
    expect(parseQuality("0")).toBeUndefined();
  });

  it("returns undefined for over 100", () => {
    expect(parseQuality("101")).toBeUndefined();
  });
});

describe("resolveContentType", () => {
  it("returns correct types", () => {
    expect(resolveContentType("webp")).toBe("image/webp");
    expect(resolveContentType("avif")).toBe("image/avif");
    expect(resolveContentType("png")).toBe("image/png");
    expect(resolveContentType("jpeg")).toBe("image/jpeg");
  });
});

describe("GET /images/*key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_SERVICE_API_KEY = "test-api-key";
  });

  it("returns 404 when image not found in R2", async () => {
    mockGetFromR2.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Image not found");
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("serves original image when no transform params", async () => {
    mockGetFromR2.mockResolvedValue({
      body: RED_PNG,
      contentType: "image/png",
    });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "completed", expect.any(Object));
  });

  it("resizes image when w param provided", async () => {
    mockGetFromR2.mockResolvedValue({
      body: RED_PNG,
      contentType: "image/png",
    });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png?w=100&format=webp")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/webp");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("resizes with fit=cover", async () => {
    mockGetFromR2.mockResolvedValue({
      body: RED_PNG,
      contentType: "image/png",
    });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png?w=100&h=100&fit=cover&format=jpeg")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
  });

  it("returns 502 when runs-service is unavailable", async () => {
    vi.mocked(createRun).mockRejectedValueOnce(new Error("runs-service down"));

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to create run");
  });

  it("ignores invalid fit values", async () => {
    mockGetFromR2.mockResolvedValue({
      body: RED_PNG,
      contentType: "image/png",
    });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png?w=100&fit=invalid&format=png")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });
});
