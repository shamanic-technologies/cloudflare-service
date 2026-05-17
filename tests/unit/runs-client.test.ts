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

  it("declareActualCost POSTs /v1/runs/:id/costs w/ status=actual", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ costs: [{ id: "cost-1" }] }),
    }) as never;

    const { declareActualCost } = await import("../../src/lib/runs-client.js");
    await declareActualCost(
      "run-abc",
      { costName: "cloudflare-r2-class-a-operation", costSource: "platform", quantity: 1 },
      { orgId: "org-1", userId: "user-1" }
    );

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("https://runs.example.com/v1/runs/run-abc/costs");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [
        {
          costName: "cloudflare-r2-class-a-operation",
          costSource: "platform",
          quantity: 1,
          status: "actual",
        },
      ],
    });
  });

  it("declareActualCost forwards x-campaign-id, x-brand-id, x-workflow-* when supplied", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ costs: [] }),
    }) as never;

    const { declareActualCost } = await import("../../src/lib/runs-client.js");
    await declareActualCost(
      "run-abc",
      { costName: "x", costSource: "org", quantity: 1 },
      { orgId: "org-1", userId: "user-1" },
      { "x-campaign-id": "c-1", "x-brand-id": "b-1", "x-workflow-slug": "wf-1" }
    );

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-campaign-id"]).toBe("c-1");
    expect(headers["x-brand-id"]).toBe("b-1");
    expect(headers["x-workflow-slug"]).toBe("wf-1");
  });

  it("declareActualCost throws fail-loud on non-2xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"error":"Unknown cost name"}'),
    }) as never;

    const { declareActualCost } = await import("../../src/lib/runs-client.js");
    await expect(
      declareActualCost(
        "run-abc",
        { costName: "bogus", costSource: "platform", quantity: 1 },
        { orgId: "org-1", userId: "user-1" }
      )
    ).rejects.toThrow(/declareActualCost failed.*422/);
  });
});
