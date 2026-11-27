import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { apiKeyAuth } from "../../src/middleware/auth.js";

// SSRF-1127: `POST /upload` must never make this service fetch a non-public
// address, directly, through a redirect, or through a name resolving inside.

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-child-123" }),
  updateRun: vi.fn().mockResolvedValue(undefined),
  declareActualCost: vi.fn().mockResolvedValue(undefined),
  createPlatformRun: vi.fn().mockResolvedValue({ id: "platform-run-123" }),
  updatePlatformRun: vi.fn().mockResolvedValue(undefined),
  declarePlatformActualCost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/key-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "mock-key", keySource: "platform" }),
  decryptPlatformKey: vi.fn().mockResolvedValue({ key: "mock-key" }),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCustomerBalance: vi.fn().mockResolvedValue({
    sufficient: true,
    balance_cents: "1000.0000",
    required_cents: "0.0009",
  }),
}));

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadToR2: vi.fn().mockResolvedValue("https://storage.mcpfactory.org/videos/test.mp4"),
}));

vi.mock("../../src/db/index.js", () => {
  const record = {
    id: "00000000-0000-0000-0000-000000000099",
    publicUrl: "https://storage.mcpfactory.org/videos/test.mp4",
    sizeBytes: 1024,
    contentType: "video/mp4",
  };
  return {
    db: {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([record]),
          }),
          returning: vi.fn().mockResolvedValue([record]),
        }),
      }),
    },
  };
});

import uploadRouter from "../../src/routes/upload.js";
import { uploadToR2 } from "../../src/lib/r2-client.js";
import {
  checkPublicUrl,
  isPublicAddress,
  publicFetch,
  PublicUrlRefusedError,
  setPublicFetchTestDefaults,
  type CheckedHop,
  type Resolver,
} from "../../src/lib/safe-fetch.js";

const PUBLIC_IP = "93.184.215.14";

/** Fake DNS: `*.nip.io` answers the IP spelled in the name (like the real nip.io); anything else is public. */
const fakeDns: Resolver = async (host) => {
  const nip = host.match(/^(\d+\.\d+\.\d+\.\d+)\.nip\.io$/);
  if (nip) return [{ address: nip[1], family: 4 }];
  return [{ address: PUBLIC_IP, family: 4 }];
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Every hop a request reached (the pinned address it dialled + the URL). */
let dialled: CheckedHop[] = [];
/** What the fake internet answers per URL. */
let routes: Record<string, () => Response> = {};

function fakeInternet() {
  dialled = [];
  routes = {};
  setPublicFetchTestDefaults({
    resolve: fakeDns,
    transport: async (hop) => {
      dialled.push(hop);
      const answer = routes[hop.url.href];
      if (!answer) return new Response("internal secret", { status: 200, headers: { "content-type": "application/json" } });
      return answer();
    },
  });
}

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

async function upload(sourceUrl: string, extra: Record<string, unknown> = {}) {
  return request(createApp()).post("/upload").set(authHeaders).send({ sourceUrl, ...extra });
}

describe("POST /upload refuses non-public sources (SSRF-1127)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_SERVICE_API_KEY = "test-api-key";
    fakeInternet();
  });

  afterEach(() => setPublicFetchTestDefaults({}));

  const refused = [
    "http://127.0.0.1:8080/keys",
    "http://localhost:8080/",
    "http://key-service:8080/platform-keys",
    "http://10.0.0.5/",
    "http://172.17.0.1:2019/config/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]:8080/",
    "http://[::ffff:7f00:1]:8080/",
    "http://127.0.0.1.nip.io:2019/config/",
    "http://172.17.0.1.nip.io:2019/config/",
    "http://169.254.169.254.nip.io/latest/meta-data/",
    "http://2130706433:8080/",
    "http://62.83.93.230.nip.io/",
  ];

  for (const url of refused) {
    it(`refuses ${url} with 400 source_url_not_public, nothing dialled`, async () => {
      const res = await upload(url);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("source_url_not_public");
      expect(dialled).toHaveLength(0);
      expect(uploadToR2).not.toHaveBeenCalled();
    });
  }

  it("refuses a public URL that 302-redirects to a private one; the private hop is never dialled", async () => {
    routes["https://cdn.example.com/logo.png"] = () =>
      new Response(null, { status: 302, headers: { location: "http://key-service:8080/platform-keys" } });
    const res = await upload("https://cdn.example.com/logo.png");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("source_url_not_public");
    expect(dialled.map((h) => h.url.href)).toEqual(["https://cdn.example.com/logo.png"]);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a nip.io name resolving to the metadata address", async () => {
    routes["https://cdn.example.com/a.png"] = () =>
      new Response(null, { status: 301, headers: { location: "http://169.254.169.254.nip.io/latest/meta-data/" } });
    const res = await upload("https://cdn.example.com/a.png");
    expect(res.status).toBe(400);
    expect(dialled).toHaveLength(1);
  });

  it("refuses a public source that is not media with 415 source_not_media", async () => {
    routes["https://example.com/page"] = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
    const res = await upload("https://example.com/page");
    expect(res.status).toBe(415);
    expect(res.body.code).toBe("source_not_media");
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it("refuses octet-stream bytes that are not an image", async () => {
    routes["https://example.com/blob"] = () =>
      new Response('{"key":"x"}', { status: 200, headers: { "content-type": "application/octet-stream" } });
    const res = await upload("https://example.com/blob");
    expect(res.status).toBe(415);
  });

  it("refuses a caller contentType that is not media", async () => {
    routes["https://example.com/logo.png"] = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    const res = await upload("https://example.com/logo.png", { contentType: "text/html" });
    expect(res.status).toBe(415);
    expect(dialled).toHaveLength(0);
  });

  it("still stores a public https image (pinned to the address that was checked)", async () => {
    routes["https://example.com/logo.png"] = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    const res = await upload("https://example.com/logo.png", { filename: "logo.png" });
    expect(res.status).toBe(200);
    expect(dialled).toHaveLength(1);
    expect(dialled[0].address).toBe(PUBLIC_IP);
    expect(vi.mocked(uploadToR2).mock.calls[0][2]).toStrictEqual(PNG);
    expect(vi.mocked(uploadToR2).mock.calls[0][3]).toBe("image/png");
  });

  it("follows a public-to-public redirect and stores the image", async () => {
    routes["https://example.com/old.png"] = () =>
      new Response(null, { status: 302, headers: { location: "https://cdn2.example.com/new.png" } });
    routes["https://cdn2.example.com/new.png"] = () =>
      new Response(PNG, { status: 200, headers: { "content-type": "application/octet-stream" } });
    const res = await upload("https://example.com/old.png");
    expect(res.status).toBe(200);
    expect(vi.mocked(uploadToR2).mock.calls[0][3]).toBe("image/png");
  });
});

describe("safe-fetch guard", () => {
  afterEach(() => setPublicFetchTestDefaults({}));

  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of [PUBLIC_IP, "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it("refuses a name when ANY of its addresses is private (rebinding-style multi-answer)", async () => {
    const resolve: Resolver = async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expect(checkPublicUrl("https://mixed.example.com/", { resolve })).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });

  it("refuses non-http protocols", async () => {
    await expect(checkPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });

  it("the real node transport never connects to a loopback server", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.end("secret");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(publicFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(PublicUrlRefusedError);
      await expect(publicFetch(`http://localhost:${port}/`)).rejects.toBeInstanceOf(PublicUrlRefusedError);
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});
