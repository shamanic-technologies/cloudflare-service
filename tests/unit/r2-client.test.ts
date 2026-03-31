import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => {
  const send = vi.fn().mockResolvedValue({});
  const S3Client = vi.fn().mockImplementation(() => ({ send }));
  const PutObjectCommand = vi.fn();
  const DeleteObjectCommand = vi.fn();
  const GetObjectCommand = vi.fn();
  return { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand };
});

import { uploadToR2, type R2Config } from "../../src/lib/r2-client.js";

const baseConfig: R2Config = {
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  accountId: "test-account-id",
  bucketName: "test-bucket",
  publicDomain: "pub-abc123.r2.dev",
};

describe("uploadToR2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct URL when publicDomain has no protocol", async () => {
    const url = await uploadToR2(baseConfig, "brands/img.png", Buffer.from("x"));
    expect(url).toBe("https://pub-abc123.r2.dev/brands/img.png");
  });

  it("strips https:// prefix to avoid double-protocol URLs", async () => {
    const config: R2Config = { ...baseConfig, publicDomain: "https://pub-abc123.r2.dev" };
    const url = await uploadToR2(config, "brands/img.png", Buffer.from("x"));
    expect(url).toBe("https://pub-abc123.r2.dev/brands/img.png");
  });

  it("strips http:// prefix", async () => {
    const config: R2Config = { ...baseConfig, publicDomain: "http://pub-abc123.r2.dev" };
    const url = await uploadToR2(config, "brands/img.png", Buffer.from("x"));
    expect(url).toBe("https://pub-abc123.r2.dev/brands/img.png");
  });
});
