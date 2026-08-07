import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Readable } from "stream";
import type { R2ListedObject } from "../../src/lib/r2-client.js";
import type { DumpManifest } from "../../src/backup/dump.js";

const uploads = new Map<string, Buffer>();
let stored: R2ListedObject[] = [];
const deleted: string[] = [];

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadStreamToR2: vi.fn(async (_c, key: string, body: Readable) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const stored_body = Buffer.concat(chunks);
    uploads.set(key, stored_body);
    stored = [
      ...stored.filter((object) => object.key !== key),
      { key, size: stored_body.length, lastModified: new Date("2026-08-07T03:00:00Z") },
    ];
    return `https://cdn.test/${key}`;
  }),
  listR2Objects: vi.fn(async (_c, prefix: string) =>
    stored.filter((object) => object.key.startsWith(prefix))
  ),
  getFromR2: vi.fn(async (_c, key: string) => {
    const body = uploads.get(key);
    return body ? { body, contentType: "application/json" } : null;
  }),
  deleteFromR2: vi.fn(async (_c, key: string) => {
    deleted.push(key);
    stored = stored.filter((object) => object.key !== key);
  }),
}));

const dumpDatabaseToR2 = vi.fn();
vi.mock("../../src/backup/dump.js", () => ({ dumpDatabaseToR2 }));

const { runBackupJob, backupStamp, assertNoTableRegression, readPgDumpMajorVersion } = await import(
  "../../src/backup/run.js"
);
const { FakeChild, makeFakeSpawn } = await import("./fake-child-process.js");

const R2 = {
  accessKeyId: "a",
  secretAccessKey: "b",
  accountId: "c",
  bucketName: "bucket",
  publicDomain: "cdn.test",
};

const SETTINGS = {
  dbKeyPrefix: "pg-backup-dsn-",
  r2Prefix: "pg-backups",
  retentionDays: 30,
  minKeep: 7,
  monitorSlug: "pg-backup-daily",
  cronSchedule: "0 3 * * *",
};

const NOW = new Date("2026-08-07T03:00:00.000Z");

function versionSpawn(version = "pg_dump (PostgreSQL) 17.5 (Debian)") {
  return makeFakeSpawn((file) => {
    const child = new FakeChild(file);
    setImmediate(() => {
      child.stdout.write(`${version}\n`);
      child.finish(0);
    });
    return child;
  }).spawnFn;
}

function manifest(database: string, tableCount: number): DumpManifest {
  return {
    database,
    r2Key: `pg-backups/${database}/x.dump`,
    tocKey: `pg-backups/${database}/x.toc.txt`,
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    durationMs: 10,
    bytes: 1024,
    sha256: "deadbeef",
    toc: { entryCount: tableCount * 2, entryTypes: { TABLE: tableCount }, tableCount },
  };
}

describe("backupStamp", () => {
  it("is sortable and free of R2-hostile characters", () => {
    expect(backupStamp(NOW)).toBe("2026-08-07T030000Z");
  });
});

describe("readPgDumpMajorVersion", () => {
  it("parses the client major version", async () => {
    const version = await readPgDumpMajorVersion(versionSpawn());
    expect(version.major).toBe(17);
  });
});

describe("assertNoTableRegression", () => {
  it("accepts an empty dump when there is no previous backup", () => {
    expect(() => assertNoTableRegression("new-service", manifest("new-service", 0), null)).not.toThrow();
  });

  it("accepts an empty dump when the previous backup was empty too", () => {
    expect(() =>
      assertNoTableRegression("empty", manifest("empty", 0), manifest("empty", 0))
    ).not.toThrow();
  });

  it("rejects a dump that lost every table", () => {
    expect(() =>
      assertNoTableRegression("runs-service", manifest("runs-service", 0), manifest("runs-service", 42))
    ).toThrow(/contains 0 tables but the previous backup/);
  });
});

describe("runBackupJob", () => {
  beforeEach(() => {
    uploads.clear();
    stored = [];
    deleted.length = 0;
    dumpDatabaseToR2.mockReset();
  });

  const targets = [
    { name: "runs-service", provider: "pg-backup-dsn-runs-service", dsn: "postgres://h/runs" },
    { name: "billing-service", provider: "pg-backup-dsn-billing-service", dsn: "postgres://h/bill" },
  ];

  it("refuses to run with a pg_dump older than the fleet's servers", async () => {
    await expect(
      runBackupJob({
        settings: SETTINGS,
        now: () => NOW,
        spawnFn: versionSpawn("pg_dump (PostgreSQL) 14.11 (Debian)"),
        r2Config: R2,
        targets,
      })
    ).rejects.toThrow(/too old — PostgreSQL 17\+ client required/);
  });

  it("writes one dump, toc and manifest per database plus a run summary", async () => {
    dumpDatabaseToR2.mockImplementation(async (params: { database: string }) =>
      manifest(params.database, 12)
    );

    const summary = await runBackupJob({
      settings: SETTINGS,
      now: () => NOW,
      spawnFn: versionSpawn(),
      r2Config: R2,
      targets,
    });

    expect(summary.okCount).toBe(2);
    expect(summary.failedCount).toBe(0);
    expect(dumpDatabaseToR2).toHaveBeenCalledTimes(2);

    expect(dumpDatabaseToR2.mock.calls[0][0]).toMatchObject({
      database: "runs-service",
      r2Key: "pg-backups/runs-service/2026-08-07T030000Z.dump",
      tocKey: "pg-backups/runs-service/2026-08-07T030000Z.toc.txt",
    });

    expect([...uploads.keys()]).toContain(
      "pg-backups/runs-service/2026-08-07T030000Z.manifest.json"
    );
    expect([...uploads.keys()]).toContain("pg-backups/_runs/latest.json");

    const latest = JSON.parse(uploads.get("pg-backups/_runs/latest.json")!.toString());
    expect(latest.databases.map((d: { database: string }) => d.database)).toEqual([
      "runs-service",
      "billing-service",
    ]);
  });

  it("keeps backing up the other databases when one fails, and reports the failure", async () => {
    dumpDatabaseToR2.mockImplementation(async (params: { database: string }) => {
      if (params.database === "runs-service") throw new Error("could not connect to server");
      return manifest(params.database, 5);
    });

    const summary = await runBackupJob({
      settings: SETTINGS,
      now: () => NOW,
      spawnFn: versionSpawn(),
      r2Config: R2,
      targets,
    });

    expect(summary.failedCount).toBe(1);
    expect(summary.okCount).toBe(1);

    const failed = summary.databases.find((d) => d.database === "runs-service");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/could not connect to server/);

    // The healthy database still produced a real backup...
    expect([...uploads.keys()]).toContain(
      "pg-backups/billing-service/2026-08-07T030000Z.manifest.json"
    );
    // ...and the failing one produced no manifest that could be mistaken for one.
    expect([...uploads.keys()]).not.toContain(
      "pg-backups/runs-service/2026-08-07T030000Z.manifest.json"
    );
    // The failure is durably traceable in the run summary on R2.
    const latest = JSON.parse(uploads.get("pg-backups/_runs/latest.json")!.toString());
    expect(latest.failedCount).toBe(1);
  });

  it("fails the database whose dump lost every table", async () => {
    const previousKey = "pg-backups/runs-service/2026-08-06T030000Z.manifest.json";
    uploads.set(previousKey, Buffer.from(JSON.stringify(manifest("runs-service", 42))));
    stored = [{ key: previousKey, size: 10, lastModified: new Date("2026-08-06T03:00:00Z") }];

    dumpDatabaseToR2.mockImplementation(async (params: { database: string }) =>
      manifest(params.database, 0)
    );

    const summary = await runBackupJob({
      settings: SETTINGS,
      now: () => NOW,
      spawnFn: versionSpawn(),
      r2Config: R2,
      targets: [targets[0]],
    });

    expect(summary.failedCount).toBe(1);
    expect(summary.databases[0].error).toMatch(/contains 0 tables/);
  });

  it("prunes backups past the retention window", async () => {
    stored = [
      {
        key: "pg-backups/runs-service/2026-01-01T030000Z.dump",
        size: 10,
        lastModified: new Date("2026-01-01T03:00:00Z"),
      },
      {
        key: "pg-backups/runs-service/2026-01-01T030000Z.manifest.json",
        size: 10,
        lastModified: new Date("2026-01-01T03:00:00Z"),
      },
    ];
    uploads.set(
      "pg-backups/runs-service/2026-01-01T030000Z.manifest.json",
      Buffer.from(JSON.stringify(manifest("runs-service", 3)))
    );

    dumpDatabaseToR2.mockImplementation(async (params: { database: string }) =>
      manifest(params.database, 3)
    );

    const summary = await runBackupJob({
      settings: { ...SETTINGS, minKeep: 1 },
      now: () => NOW,
      spawnFn: versionSpawn(),
      r2Config: R2,
      targets: [targets[0]],
    });

    expect(summary.databases[0].prune?.deletedGroups).toEqual(["2026-01-01T030000Z"]);
    expect(deleted).toHaveLength(2);
  });
});
