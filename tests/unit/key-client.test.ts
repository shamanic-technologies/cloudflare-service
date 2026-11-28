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

  it("the storage service's org decrypt keeps X-Caller-Service: cloudflare-storage", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: "k", keySource: "org" }),
    }) as never;

    const { decryptKey } = await import("../../src/lib/key-client.js");
    await decryptKey("cloudflare-r2-bucket-name", "org-1", "user-1", {
      callerMethod: "POST",
      callerPath: "/upload",
    });

    const headers = (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Caller-Service"]).toBe("cloudflare-storage");
  });

  it("listPlatformKeys sends the caller name it is given", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [{ provider: "pg-backup-dsn-a" }] }),
    }) as never;

    const { listPlatformKeys } = await import("../../src/lib/key-client.js");
    expect(await listPlatformKeys("pg-backup")).toEqual(["pg-backup-dsn-a"]);

    const headers = (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Caller-Service"]).toBe("pg-backup");
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
