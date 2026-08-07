import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import type { Readable } from "stream";

const uploads: { key: string; body: Buffer; contentType?: string }[] = [];

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadStreamToR2: vi.fn(async (_config, key: string, body: Readable, contentType?: string) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    uploads.push({ key, body: Buffer.concat(chunks), contentType });
    return `https://cdn.test/${key}`;
  }),
}));

const { dumpDatabaseToR2, parseTocListing } = await import("../../src/backup/dump.js");
const { FakeChild, makeFakeSpawn } = await import("./fake-child-process.js");

const R2 = {
  accessKeyId: "a",
  secretAccessKey: "b",
  accountId: "c",
  bucketName: "bucket",
  publicDomain: "cdn.test",
};

const LISTING = [
  ";",
  "; Archive created at 2026-08-07 03:00:00 UTC",
  ";     dbname: runs",
  ";",
  ";",
  "; Selected TOC Entries:",
  ";",
  "215; 1259 16385 TABLE public runs postgres",
  "216; 1259 16390 TABLE public run_costs postgres",
  "3412; 0 16385 TABLE DATA public runs postgres",
  "3413; 0 16390 TABLE DATA public run_costs postgres",
  "3200; 2606 16400 CONSTRAINT public runs runs_pkey postgres",
  "",
].join("\n");

describe("parseTocListing", () => {
  it("counts entries and tables, ignoring comments", () => {
    const toc = parseTocListing(LISTING);
    expect(toc.entryCount).toBe(5);
    expect(toc.tableCount).toBe(2);
    expect(toc.entryTypes["TABLE DATA"]).toBe(2);
    expect(toc.entryTypes["CONSTRAINT"]).toBe(1);
  });

  it("reports zero for the archive of an empty database", () => {
    const toc = parseTocListing(";\n; Archive created at 2026-08-07\n;\n");
    expect(toc.entryCount).toBe(0);
    expect(toc.tableCount).toBe(0);
  });
});

describe("dumpDatabaseToR2", () => {
  beforeEach(() => {
    uploads.length = 0;
  });

  function plan(payload: Buffer, opts: { dumpCode?: number; listCode?: number } = {}) {
    const children: Record<string, InstanceType<typeof FakeChild>> = {};
    const { spawnFn, calls } = makeFakeSpawn((file) => {
      const child = new FakeChild(file);
      children[file] = child;
      if (file === "pg_dump") {
        setImmediate(() => {
          child.stdout.write(payload);
          if (opts.dumpCode) child.stderr.write("connection refused");
          child.finish(opts.dumpCode ?? 0);
        });
      } else {
        setImmediate(() => {
          child.stdout.write(LISTING);
          if (opts.listCode) child.stderr.write("did not find magic string");
          child.finish(opts.listCode ?? 0);
        });
      }
      return child;
    });
    return { spawnFn, calls, children };
  }

  it("streams the dump to R2, hashes it, and stores the TOC sidecar", async () => {
    const payload = Buffer.from("PGDMP-fake-archive-bytes");
    const { spawnFn, calls } = plan(payload);

    const manifest = await dumpDatabaseToR2(
      {
        database: "runs-service",
        dsn: "postgres://user@host/runs",
        r2Config: R2,
        r2Key: "pg-backups/runs-service/2026-08-07T030000Z.dump",
        tocKey: "pg-backups/runs-service/2026-08-07T030000Z.toc.txt",
      },
      { spawnFn }
    );

    expect(calls[0].file).toBe("pg_dump");
    expect(calls[0].args).toContain("--format=custom");
    expect(calls[1]).toEqual({ file: "pg_restore", args: ["--list"] });

    expect(manifest.bytes).toBe(payload.length);
    expect(manifest.sha256).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(manifest.toc.tableCount).toBe(2);

    const dump = uploads.find((u) => u.key.endsWith(".dump"));
    expect(dump?.body.equals(payload)).toBe(true);
    const toc = uploads.find((u) => u.key.endsWith(".toc.txt"));
    expect(toc?.body.toString()).toContain("TABLE public runs");
  });

  it("throws when pg_dump fails instead of storing a partial archive", async () => {
    const { spawnFn } = plan(Buffer.from("partial"), { dumpCode: 1 });

    await expect(
      dumpDatabaseToR2(
        {
          database: "runs-service",
          dsn: "postgres://user@host/runs",
          r2Config: R2,
          r2Key: "k.dump",
          tocKey: "k.toc.txt",
        },
        { spawnFn }
      )
    ).rejects.toThrow(/pg_dump failed for "runs-service" \(exit 1\): connection refused/);

    expect(uploads.some((u) => u.key.endsWith(".toc.txt"))).toBe(false);
  });

  it("throws when pg_restore --list rejects the archive", async () => {
    const { spawnFn } = plan(Buffer.from("corrupt"), { listCode: 1 });

    await expect(
      dumpDatabaseToR2(
        {
          database: "runs-service",
          dsn: "postgres://user@host/runs",
          r2Config: R2,
          r2Key: "k.dump",
          tocKey: "k.toc.txt",
        },
        { spawnFn }
      )
    ).rejects.toThrow(/pg_restore --list rejected the dump/);
  });
});
