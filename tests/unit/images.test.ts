import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { apiKeyAuth } from "../../src/middleware/auth.js";

const mockGetFromR2 = vi.fn();

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
    required_cents: "0.000072",
  }),
}));

vi.mock("../../src/lib/r2-client.js", () => ({
  getFromR2: (...args: unknown[]) => mockGetFromR2(...args),
}));

import imagesRouter from "../../src/routes/images.js";
import { parsePositiveInt, parseQuality, resolveContentType } from "../../src/routes/images.js";
import { createRun, updateRun, declareActualCost } from "../../src/lib/runs-client.js";
import { authorizeCustomerBalance } from "../../src/lib/billing-client.js";
import { decryptKey } from "../../src/lib/key-client.js";

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
    vi.mocked(decryptKey).mockResolvedValue({ key: "mock-key", keySource: "platform" });
    vi.mocked(authorizeCustomerBalance).mockResolvedValue({
      sufficient: true,
      balance_cents: "1000.0000",
      required_cents: "0.000072",
    });
  });

  it("returns 404 when image not found in R2", async () => {
    mockGetFromR2.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Image not found");
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("platform: authorizes, serves original, declares actual cost, marks completed", async () => {
    mockGetFromR2.mockResolvedValue({ body: RED_PNG, contentType: "image/png" });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(authorizeCustomerBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ costName: "cloudflare-r2-class-b-operation", quantity: 1 }],
        runId: "run-child-123",
      })
    );
    expect(declareActualCost).toHaveBeenCalledWith(
      "run-child-123",
      { costName: "cloudflare-r2-class-b-operation", costSource: "platform", quantity: 1 },
      expect.any(Object),
      expect.any(Object)
    );
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "completed", expect.any(Object));
  });

  it("platform sufficient=false: returns 402, no R2 GET, no cost row, run failed", async () => {
    vi.mocked(authorizeCustomerBalance).mockResolvedValue({
      sufficient: false,
      balance_cents: "0.0000",
      required_cents: "0.000072",
    });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(402);
    expect(res.body.error).toBe("Insufficient credit balance");
    expect(mockGetFromR2).not.toHaveBeenCalled();
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("org: skips authorize, serves image, declares actual cost w/ costSource=org", async () => {
    vi.mocked(decryptKey).mockResolvedValue({ key: "mock-key", keySource: "org" });
    mockGetFromR2.mockResolvedValue({ body: RED_PNG, contentType: "image/png" });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(authorizeCustomerBalance).not.toHaveBeenCalled();
    expect(declareActualCost).toHaveBeenCalledWith(
      "run-child-123",
      { costName: "cloudflare-r2-class-b-operation", costSource: "org", quantity: 1 },
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("keySource mismatch: 500, no R2 GET, no cost row, run failed", async () => {
    vi.mocked(decryptKey)
      .mockResolvedValueOnce({ key: "k1", keySource: "platform" })
      .mockResolvedValueOnce({ key: "k2", keySource: "org" })
      .mockResolvedValueOnce({ key: "k3", keySource: "platform" })
      .mockResolvedValueOnce({ key: "k4", keySource: "platform" })
      .mockResolvedValueOnce({ key: "k5", keySource: "platform" });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png")
      .set(authHeaders);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Inconsistent keySource across R2 credentials");
    expect(authorizeCustomerBalance).not.toHaveBeenCalled();
    expect(mockGetFromR2).not.toHaveBeenCalled();
    expect(declareActualCost).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("run-child-123", "failed", expect.any(Object));
  });

  it("resizes image when w param provided + declares cost", async () => {
    mockGetFromR2.mockResolvedValue({ body: RED_PNG, contentType: "image/png" });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png?w=100&format=webp")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/webp");
    expect(declareActualCost).toHaveBeenCalledWith(
      "run-child-123",
      expect.objectContaining({ costName: "cloudflare-r2-class-b-operation", quantity: 1 }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("resizes with fit=cover", async () => {
    mockGetFromR2.mockResolvedValue({ body: RED_PNG, contentType: "image/png" });

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
    mockGetFromR2.mockResolvedValue({ body: RED_PNG, contentType: "image/png" });

    const app = createApp();
    const res = await request(app)
      .get("/images/brands/uuid/logo.png?w=100&fit=invalid&format=png")
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });
});
