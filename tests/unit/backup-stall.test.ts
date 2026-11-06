import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Readable } from "stream";

/**
 * BACKUP-HANG-1106: the 2026-11-03 run sat 3.5 days in lead_service's COPY
 * because the dump's consumer stopped reading. These tests drive the REAL dump
 * and run code with fake pg_dump / pg_restore processes and a fake R2.
 */

const uploads = new Map<string, Buffer>();
/** Keys whose upload never reads its body: a dead R2 socket. */
const deadUploads = new Set<string>();

vi.mock("../../src/lib/r2-client.js", () => ({
  uploadStreamToR2: vi.fn(async (_c, key: string, body: Readable) => {
    if ([...deadUploads].some((prefix) => key.startsWith(prefix))) {
      // Never reads; settles only when the dump destroys the body.
      await new Promise((_resolve, reject) => body.on("error", reject).on("close", () => reject(new Error("closed"))));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    uploads.set(key, Buffer.concat(chunks));
    return `https://cdn.test/${key}`;
  }),
  listR2Objects: vi.fn(async () => []),
  getFromR2: vi.fn(async () => null),
  deleteFromR2: vi.fn(async () => undefined),
}));

const { dumpDatabaseToR2, DumpAbortedError } = await import("../../src/backup/dump.js");
const { runBackupJob, summaryLine } = await import("../../src/backup/run.js");
const { FakeChild, makeFakeSpawn } = await import("./fake-child-process.js");

const R2 = { accessKeyId: "a", secretAccessKey: "b", accountId: "c", bucketName: "bucket", publicDomain: "cdn.test" };
const LISTING = "215; 1259 16385 TABLE public runs postgres\n3412; 0 16385 TABLE DATA public runs postgres\n";

type Behaviour = "ok" | "silent" | "endless";

/**
 * pg_dump per database (read off its --dbname): "ok" dumps and exits, "silent"
 * writes a header then hangs (ignoring SIGTERM, like a process stuck in a
 * write), "endless" keeps writing forever (never stalls, never finishes).
 */
function fleetSpawn(behaviours: Record<string, Behaviour>) {
  const children: InstanceType<typeof FakeChild>[] = [];
  const timers: NodeJS.Timeout[] = [];
  const { spawnFn, calls } = makeFakeSpawn((file, args) => {
    const child = new FakeChild(file);
    children.push(child);
    if (file === "pg_dump" && args[0] === "--version") {
      setImmediate(() => {
        child.stdout.write("pg_dump (PostgreSQL) 17.5\n");
        child.finish(0);
      });
    } else if (file === "pg_dump") {
      const dsn = args[args.indexOf("--dbname") + 1];
      const behaviour = behaviours[dsn.split("/").pop()!] ?? "ok";
      if (behaviour === "ok") {
        setImmediate(() => {
          child.stdout.write(Buffer.from("PGDMP-archive"));
          child.finish(0);
        });
      } else if (behaviour === "silent") {
        child.ignoreTerm = true;
        setImmediate(() => child.stdout.write(Buffer.from("PGDMP-header")));
      } else {
        const timer = setInterval(() => {
          if (child.signalCode === null) child.stdout.write(Buffer.alloc(64 * 1024, 1));
        }, 2);
        timers.push(timer);
      }
    } else {
      // pg_restore --list answers once its stdin ends; dies with the dump.
      child.stdin.on("end", () => {
        child.stdout.write(LISTING);
        child.finish(0);
      });
    }
    return child;
  });
  return { spawnFn, calls, children, stop: () => timers.forEach(clearInterval) };
}

const GUARD = { checkEveryMs: 5, killGraceMs: 20 };

describe("a dump that stops moving is ended (BACKUP-HANG-1106)", () => {
  beforeEach(() => {
    uploads.clear();
    deadUploads.clear();
  });

  it("ends a silent pg_dump: TERM, then KILL when it ignores TERM, fails with the reason", async () => {
    const fleet = fleetSpawn({ lead: "silent" });
    const error = await dumpDatabaseToR2(
      { database: "lead-service", dsn: "postgres://h/lead", r2Config: R2, r2Key: "x/lead.dump", tocKey: "x/lead.toc.txt" },
      { spawnFn: fleet.spawnFn, stallMs: 60, ...GUARD }
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DumpAbortedError);
    expect((error as InstanceType<typeof DumpAbortedError>).kind).toBe("stalled");
    expect(String(error)).toMatch(/lead-service.*stalled: no byte from pg_dump/);

    const pgDump = fleet.children.find((c) => c.spawnfile === "pg_dump")!;
    expect(pgDump.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fleet.children.find((c) => c.spawnfile === "pg_restore")!.signals[0]).toBe("SIGTERM");
    // Nothing that could pass for a backup was stored.
    expect(uploads.has("x/lead.toc.txt")).toBe(false);
    expect(uploads.has("x/lead.dump")).toBe(false);
  });

  it("ends a dump whose R2 upload stopped reading (the 2026-11-03 hang)", async () => {
    deadUploads.add("x/lead.dump");
    const fleet = fleetSpawn({ lead: "endless" });
    const error = await dumpDatabaseToR2(
      { database: "lead-service", dsn: "postgres://h/lead", r2Config: R2, r2Key: "x/lead.dump", tocKey: "x/lead.toc.txt" },
      { spawnFn: fleet.spawnFn, stallMs: 60, ...GUARD }
    ).catch((e: unknown) => e);
    fleet.stop();

    // pg_dump kept trying to write; backpressure stopped its bytes reaching us.
    expect((error as InstanceType<typeof DumpAbortedError>).kind).toBe("stalled");
    expect(fleet.children.find((c) => c.spawnfile === "pg_dump")!.signalCode).toBe("SIGTERM");
  });

  it("ends a dump that keeps moving but runs past its time budget", async () => {
    const fleet = fleetSpawn({ lead: "endless" });
    const error = await dumpDatabaseToR2(
      { database: "lead-service", dsn: "postgres://h/lead", r2Config: R2, r2Key: "x/lead.dump", tocKey: "x/lead.toc.txt" },
      { spawnFn: fleet.spawnFn, stallMs: 10_000, budgetMs: 80, ...GUARD }
    ).catch((e: unknown) => e);
    fleet.stop();

    expect((error as InstanceType<typeof DumpAbortedError>).kind).toBe("over_budget");
    expect(String(error)).toMatch(/passed its time budget/);
  });

  it("asks Postgres never to queue forever for its locks", async () => {
    const fleet = fleetSpawn({});
    await dumpDatabaseToR2(
      { database: "key-service", dsn: "postgres://h/key", r2Config: R2, r2Key: "x/key.dump", tocKey: "x/key.toc.txt" },
      { spawnFn: fleet.spawnFn, stallMs: 1000, ...GUARD }
    );
    expect(fleet.calls[0].args).toContain("--lock-wait-timeout=2min");
  });
});

const SETTINGS = {
  dbKeyPrefix: "pg-backup-dsn-",
  r2Prefix: "pg-backups",
  retentionDays: 30,
  minKeep: 7,
  monitorSlug: "pg-backup-daily",
  cronSchedule: "0 3,15 * * *",
  stallMinutes: 10,
  dbBudgetMinutes: 60,
  runBudgetMinutes: 240,
};
const NOW = new Date("2026-11-06T15:00:00.000Z");
const targets = ["billing", "lead", "runs"].map((name) => ({
  name: `${name}-service`,
  provider: `pg-backup-dsn-${name}-service`,
  dsn: `postgres://h/${name}`,
}));

describe("a run with a stalled database (BACKUP-HANG-1106)", () => {
  beforeEach(() => {
    uploads.clear();
    deadUploads.clear();
  });

  it("ends the stalled dump, reports it failed, and still backs up every other database", async () => {
    const fleet = fleetSpawn({ lead: "silent" });
    const summary = await runBackupJob({
      settings: SETTINGS,
      now: () => NOW,
      spawnFn: fleet.spawnFn,
      r2Config: R2,
      targets,
      dumpGuard: { ...GUARD, stallMs: 60 },
    });

    expect(summary.databases.map((d) => [d.database, d.status])).toEqual([
      ["billing-service", "ok"],
      ["lead-service", "failed"],
      ["runs-service", "ok"],
    ]);
    expect(summary.databases[1].error).toMatch(/stalled/);
    expect(uploads.has("pg-backups/runs-service/2026-11-06T150000Z.manifest.json")).toBe(true);
    expect(uploads.has("pg-backups/lead-service/2026-11-06T150000Z.manifest.json")).toBe(false);

    // The line the box's Monitoring check reads names the failed database and why.
    const line = summaryLine(summary);
    expect(line.startsWith("PG_BACKUP_SUMMARY ")).toBe(true);
    const parsed = JSON.parse(line.slice("PG_BACKUP_SUMMARY ".length));
    expect(parsed).toMatchObject({ okCount: 2, failedCount: 1 });
    expect(parsed.failed[0].database).toBe("lead-service");
    expect(parsed.failed[0].error).toMatch(/stalled/);
  });

  it("stops at the run's budget: databases left are reported failed, never silently skipped", async () => {
    const fleet = fleetSpawn({});
    let clock = 0;
    const summary = await runBackupJob({
      settings: { ...SETTINGS, runBudgetMinutes: 60 },
      now: () => NOW,
      // Each database start reads the clock once; the second read lands past the budget.
      clockMs: () => {
        const value = clock;
        clock += 25 * 60_000;
        return value;
      },
      spawnFn: fleet.spawnFn,
      r2Config: R2,
      targets,
      dumpGuard: { ...GUARD, stallMs: 1000 },
    });

    expect(summary.databases.map((d) => d.status)).toEqual(["ok", "ok", "failed"]);
    expect(summary.databases[2].error).toMatch(/not started: the run's 60 min budget was spent/);
  });
});
