import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("billing-client", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.BILLING_SERVICE_URL = "https://billing.example.com";
    process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("throws at import if BILLING_SERVICE_URL is not set", async () => {
    delete process.env.BILLING_SERVICE_URL;
    await expect(() => import("../../src/lib/billing-client.js")).rejects.toThrow(
      "BILLING_SERVICE_URL is not set"
    );
  });

  it("throws at import if BILLING_SERVICE_API_KEY is not set", async () => {
    delete process.env.BILLING_SERVICE_API_KEY;
    await expect(() => import("../../src/lib/billing-client.js")).rejects.toThrow(
      "BILLING_SERVICE_API_KEY is not set"
    );
  });

  it("POSTs /v1/customer_balance/authorize with identity headers + body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          sufficient: true,
          balance_cents: "1000.0000",
          required_cents: "0.0009",
        }),
    }) as never;

    const { authorizeCustomerBalance } = await import("../../src/lib/billing-client.js");
    const result = await authorizeCustomerBalance({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      items: [{ costName: "cloudflare-r2-class-a-operation", quantity: 1 }],
    });

    expect(result).toEqual({
      sufficient: true,
      balance_cents: "1000.0000",
      required_cents: "0.0009",
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("https://billing.example.com/v1/customer_balance/authorize");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-billing-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(JSON.parse(init.body as string)).toEqual({
      items: [{ costName: "cloudflare-r2-class-a-operation", quantity: 1 }],
    });
  });

  it("forwards x-workflow-*, x-campaign-id, x-brand-id headers when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ sufficient: true, balance_cents: "0", required_cents: "0" }),
    }) as never;

    const { authorizeCustomerBalance } = await import("../../src/lib/billing-client.js");
    await authorizeCustomerBalance({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      items: [{ costName: "x", quantity: 1 }],
      forwardHeaders: {
        "x-campaign-id": "camp-1",
        "x-brand-id": "brand-1,brand-2",
        "x-workflow-slug": "wf-1",
        "x-workflow-run-id": "wfr-1",
      },
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-brand-id"]).toBe("brand-1,brand-2");
    expect(headers["x-workflow-slug"]).toBe("wf-1");
    expect(headers["x-workflow-run-id"]).toBe("wfr-1");
  });

  it("returns sufficient=false response shape", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          sufficient: false,
          balance_cents: "0.0000",
          required_cents: "0.0009",
        }),
    }) as never;

    const { authorizeCustomerBalance } = await import("../../src/lib/billing-client.js");
    const result = await authorizeCustomerBalance({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      items: [{ costName: "x", quantity: 1 }],
    });

    expect(result.sufficient).toBe(false);
  });

  it("throws fail-loud on non-2xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal billing error"),
    }) as never;

    const { authorizeCustomerBalance } = await import("../../src/lib/billing-client.js");
    await expect(
      authorizeCustomerBalance({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        items: [{ costName: "x", quantity: 1 }],
      })
    ).rejects.toThrow(/billing-service authorize failed.*500/);
  });

  it("throws when /v1/customer_balance/authorize returns 404 (route rename guard)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"error":"Not found"}'),
    }) as never;

    const { authorizeCustomerBalance } = await import("../../src/lib/billing-client.js");
    await expect(
      authorizeCustomerBalance({
        orgId: "org-1",
        userId: "user-1",
        runId: "run-1",
        items: [{ costName: "x", quantity: 1 }],
      })
    ).rejects.toThrow(/404/);
  });
});
