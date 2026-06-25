import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("key-client", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.KEY_SERVICE_URL = "https://keys.example.com";
    process.env.KEY_SERVICE_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("decryptPlatformKey calls platform decrypt without org/user identity", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "cloudflare-r2-access-key-id", key: "decrypted-key" }),
    }) as never;

    const { decryptPlatformKey } = await import("../../src/lib/key-client.js");
    const result = await decryptPlatformKey("cloudflare-r2-access-key-id", {
      callerMethod: "POST",
      callerPath: "/internal/upload/base64",
      audienceId: "aud-1",
    });

    expect(result).toEqual({ key: "decrypted-key" });
    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call[0]).toBe("https://keys.example.com/keys/platform/cloudflare-r2-access-key-id/decrypt");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("test-key");
    expect(headers["X-Caller-Service"]).toBe("cloudflare-storage");
    expect(headers["X-Caller-Method"]).toBe("POST");
    expect(headers["X-Caller-Path"]).toBe("/internal/upload/base64");
    expect(headers["x-audience-id"]).toBe("aud-1");
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
  });

  it("decryptPlatformKey fails loud when the platform key is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("not found"),
    }) as never;

    const { decryptPlatformKey } = await import("../../src/lib/key-client.js");
    await expect(
      decryptPlatformKey("cloudflare-r2-access-key-id", {
        callerMethod: "POST",
        callerPath: "/internal/upload/base64",
      })
    ).rejects.toThrow("cloudflare-r2 platform key not configured");
  });
});
