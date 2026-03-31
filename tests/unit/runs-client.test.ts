import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("runs-client", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.RUNS_SERVICE_URL = "https://runs.example.com";
    process.env.RUNS_SERVICE_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("throws at import if RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;
    await expect(() => import("../../src/lib/runs-client.js")).rejects.toThrow(
      "RUNS_SERVICE_URL is not set"
    );
  });

  it("throws at import if RUNS_SERVICE_API_KEY is not set", async () => {
    delete process.env.RUNS_SERVICE_API_KEY;
    await expect(() => import("../../src/lib/runs-client.js")).rejects.toThrow(
      "RUNS_SERVICE_API_KEY is not set"
    );
  });

  it("createRun calls POST /v1/runs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-123" }),
    }) as never;

    const { createRun } = await import("../../src/lib/runs-client.js");
    const result = await createRun(
      { serviceName: "cloudflare-service", taskName: "upload" },
      { orgId: "org-1", userId: "user-1" }
    );

    expect(result).toEqual({ id: "run-123" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://runs.example.com/v1/runs",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("updateRun calls PATCH /v1/runs/:id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as never;

    const { updateRun } = await import("../../src/lib/runs-client.js");
    await updateRun("run-456", "completed", { orgId: "org-1", userId: "user-1" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://runs.example.com/v1/runs/run-456",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("createRun sends X-Api-Key header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "run-789" }),
    }) as never;

    const { createRun } = await import("../../src/lib/runs-client.js");
    await createRun(
      { serviceName: "cloudflare-service", taskName: "upload" },
      { orgId: "org-1", userId: "user-1" }
    );

    const callArgs = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-key");
  });
});
