import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Readable } from "stream";

/**
 * BACKUP-HANG-1106: on 2026-11-03 a pg_dump of lead_service stalled for 3.5
 * days (its consumer stopped reading), holding a lock on every table until a
 * schema change took lead-service down. These tests drive the REAL dump and run
 * code with fake processes and a fake R2: a stalled dump must be ended (pg_dump
 * killed, which releases its locks), reported as failed, and the run must go on
 * to back up the other databases.
 */

const uploads = new Map<string, Buffer>();
/** R2 keys whose upload never reads its body: the exact 2026-11-03 failure. */
const frozenUploads = new Set<string>();

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadStreamToR2: vi.fn(
    async (_c, key: string, body: Readable, _type?: string, opts?: { signal?: AbortSignal }) => {
      if ([...frozenUploads].some((prefix) => key.startsWith(prefix))) {
        // Never reads: backpressure stops pg_dump's stdout. Only an abort ends it.
        await new Promise<void>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason));
        });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      uploads.set(key, Buffer.concat(chunks));
      return `https://cdn.test/${key}`;
    }
  ),
  listR2Objects: vi.fn(async () => []),
  getFromR2: vi.fn(async () => null),
  deleteFromR2: vi.fn(async () => undefined),
}));

const { dumpDatabaseToR2, DumpTimeoutError } = await import("../../src/backup/dump.js");
const { runBackupJob } = await import("../../src/backup/run.js");
const { FakeChild, makeFakeSpawn } = await import("./fake-child-process.js");

const R2 = {
  accessKeyId: "a",
  secretAccessKey: "b",
  accountId: "c",
  bucketName: "bucket",
  publicDomain: "cdn.test",
};

const LISTING = "215; 1259 16385 TABLE public leads postgres\n3412; 0 16385 TABLE DATA public leads postgres\n";

type Behaviour = "healthy" | "silent" | "trickle" | "flood";

/**
 * pg_dump fakes, keyed by the database name found in the DSN:
 * - healthy: writes an archive and exits 0
 * - silent:  writes a header, then never writes nor exits (server-side stall)
 * - trickle: writes a byte every 5 ms forever (alive, but never finishes)
 * - flood:   writes as fast as its consumer reads, honouring backpressure, forever
 */
function fleetSpawn(behaviours: Record<string, Behaviour>) {
  const children: InstanceType<typeof FakeChild>[] = [];
  const { spawnFn, calls } = makeFakeSpawn((file, args) => {
    const child = new FakeChild(file);
    children.push(child);
    if (file === "pg_dump" && args[0] === "--version") {
      setImmediate(() => {
        child.stdout.write("pg_dump (PostgreSQL) 17.10\n");
        child.finish(0);
      });
      return child;
    }
    if (file === "pg_restore") {
      setImmediate(() => {
        child.stdout.write(LISTING);
        child.finish(0);
      });
      return child;
    }
    const dsn = args[args.length - 1];
    const behaviour = behaviours[dsn.split("/").pop()!];
    setImmediate(() => {
      child.stdout.write(Buffer.from("PGDMP-header"));
      if (behaviour === "healthy") {
        child.stdout.write(Buffer.from("-rows"));
        child.finish(0);
      } else if (behaviour === "trickle") {
        const timer = setInterval(() => {
          if (child.killedWith) return clearInterval(timer);
          child.stdout.write(Buffer.from("x"));
        }, 5);
      } else if (behaviour === "flood") {
        const pump = () => {
          while (!child.killedWith) {
            if (!child.stdout.write(Buffer.alloc(64 * 1024))) {
              child.stdout.once("drain", pump);
              return;
            }
          }
        };
        pump();
      }
      // "silent": nothing more, ever.
    });
    return child;
  });
  return { spawnFn, calls, children };
}

const params = (database: string) => ({
  database,
  dsn: `postgres://h/${database}`,
  r2Config: R2,
  r2Key: `pg-backups/${database}/s.dump`,
  tocKey: `pg-backups/${database}/s.toc.txt`,
});

beforeEach(() => {
  uploads.clear();
  frozenUploads.clear();
});

describe("dumpDatabaseToR2 time limits", () => {
  it("ends a dump whose pg_dump goes silent, killing it so its locks are released", async () => {
    const { spawnFn, children } = fleetSpawn({ lead: "silent" });

    const error = await dumpDatabaseToR2(params("lead"), {
      spawnFn,
      stallTimeoutMs: 80,
      deadlineMs: 60_000,
      lockWaitTimeoutMs: 1000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpTimeoutError);
    expect((error as Error).message).toMatch(/pg_dump of "lead" stalled: no byte for \d+s/);
    expect((error as Error).message).toMatch(/table locks released/);
    const pgDump = children.find((c) => c.spawnfile === "pg_dump")!;
    expect(pgDump.killedWith).toBe("SIGKILL");
    // No TOC sidecar: nothing that could pass for a good backup.
    expect(uploads.has("pg-backups/lead/s.toc.txt")).toBe(false);
  });

  it("ends a dump whose upload stops reading (backpressure stalls pg_dump)", async () => {
    frozenUploads.add("pg-backups/lead/");
    const { spawnFn, children } = fleetSpawn({ lead: "flood" });

    const error = await dumpDatabaseToR2(params("lead"), {
      spawnFn,
      stallTimeoutMs: 80,
      deadlineMs: 60_000,
      lockWaitTimeoutMs: 1000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpTimeoutError);
    expect((error as Error).message).toMatch(/stalled/);
    expect(children.find((c) => c.spawnfile === "pg_dump")!.killedWith).toBe("SIGKILL");
  });

  it("ends a dump that keeps producing bytes but outlives its budget", async () => {
    const { spawnFn, children } = fleetSpawn({ lead: "trickle" });

    const error = await dumpDatabaseToR2(params("lead"), {
      spawnFn,
      stallTimeoutMs: 1_000,
      deadlineMs: 120,
      lockWaitTimeoutMs: 1000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpTimeoutError);
    expect((error as Error).message).toMatch(/exceeded its \d+s budget/);
    expect(children.find((c) => c.spawnfile === "pg_dump")!.killedWith).toBe("SIGKILL");
  });

  it("leaves a healthy dump alone", async () => {
    const { spawnFn } = fleetSpawn({ lead: "healthy" });
    const manifest = await dumpDatabaseToR2(params("lead"), {
      spawnFn,
      stallTimeoutMs: 80,
      deadlineMs: 60_000,
      lockWaitTimeoutMs: 1000,
    });
    expect(manifest.toc.tableCount).toBe(1);
    expect(uploads.get("pg-backups/lead/s.dump")?.toString()).toBe("PGDMP-header-rows");
  });
});

describe("runBackupJob with a stalled database", () => {
  const SETTINGS = {
    dbKeyPrefix: "pg-backup-dsn-",
    r2Prefix: "pg-backups",
    retentionDays: 7,
    minKeep: 7,
    monitorSlug: "pg-backup-daily",
    cronSchedule: "0 3 * * *",
    // 0.1 s stall limit, expressed in the settings' unit.
    stallTimeoutSeconds: 0.1,
    dbTimeoutMinutes: 60,
    runTimeoutMinutes: 360,
    lockWaitTimeoutSeconds: 120,
  };

  const targets = ["apollo", "lead", "runs"].map((name) => ({
    name,
    provider: `pg-backup-dsn-${name}`,
    dsn: `postgres://h/${name}`,
  }));

  it("ends the stalled dump, reports it, and still backs up the databases after it", async () => {
    const { spawnFn } = fleetSpawn({ apollo: "healthy", lead: "silent", runs: "healthy" });

    const summary = await runBackupJob({ settings: SETTINGS, spawnFn, r2Config: R2, targets });

    expect(summary.databases.map((d) => [d.database, d.status])).toEqual([
      ["apollo", "ok"],
      ["lead", "failed"],
      ["runs", "ok"],
    ]);
    expect(summary.databases[1].error).toMatch(/pg_dump of "lead" stalled/);
    expect(uploads.has("pg-backups/runs/" + summary.stamp + ".manifest.json")).toBe(true);
    // The failure is in the durable run summary too.
    const latest = JSON.parse(uploads.get("pg-backups/_runs/latest.json")!.toString());
    expect(latest.failedCount).toBe(1);
  });

  it("marks every database left when the run's budget runs out as failed, never skipped", async () => {
    const { spawnFn } = fleetSpawn({ apollo: "trickle", lead: "healthy", runs: "healthy" });

    // A 120 ms run budget: the trickling first dump (alive, never done) burns it.
    const summary = await runBackupJob({
      settings: { ...SETTINGS, stallTimeoutSeconds: 300, runTimeoutMinutes: 0.002 },
      spawnFn,
      r2Config: R2,
      targets,
    });

    expect(summary.databases[0].error).toMatch(/pg_dump of "apollo" exceeded its/);
    expect(summary.databases.slice(1).map((d) => [d.status, d.error])).toEqual([
      ["failed", "not dumped: the run's 0.002 min budget ran out before this database"],
      ["failed", "not dumped: the run's 0.002 min budget ran out before this database"],
    ]);
    expect(summary.failedCount).toBe(3);
  });
});
