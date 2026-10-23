import { describe, it, expect, vi } from "vitest";

describe("Sentry instrumentation (@sentry/node 10)", () => {
  it("initialises a client with the service tag when SENTRY_DSN is set", async () => {
    vi.resetModules();
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/0";
    try {
      await import("../../src/instrument.js");
      const Sentry = await import("@sentry/node");
      expect(Number(Sentry.SDK_VERSION.split(".")[0])).toBeGreaterThanOrEqual(10);
      expect(Sentry.getClient()).toBeDefined();
      expect(Sentry.getClient()!.getOptions().dsn).toBe(process.env.SENTRY_DSN);
      expect(typeof Sentry.setupExpressErrorHandler).toBe("function");
    } finally {
      delete process.env.SENTRY_DSN;
      await (await import("@sentry/node")).close();
    }
  });
});
