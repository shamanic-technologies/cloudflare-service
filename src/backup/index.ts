import "../instrument.js";
import * as Sentry from "@sentry/node";
import { loadSettings } from "./config.js";
import { runBackupJob } from "./run.js";
import type { RunSummary } from "./run.js";

/**
 * One machine-readable line the box cron (`backup-cron.sh`) parses to report
 * the run to dashboard v2 Monitoring > Box > Watchdogs, red when any database
 * got no backup. Printed for every outcome, including a run that died before
 * dumping anything.
 */
function printResult(summary: RunSummary | null, fatal: string | null): void {
  const result = {
    stamp: summary?.stamp ?? null,
    okCount: summary?.okCount ?? 0,
    failedCount: summary?.failedCount ?? 0,
    ok: summary?.databases.filter((d) => d.status === "ok").map((d) => d.database) ?? [],
    failed:
      summary?.databases
        .filter((d) => d.status === "failed")
        .map((d) => ({ database: d.database, error: (d.error ?? "").slice(0, 500) })) ?? [],
    fatal,
  };
  console.log(`[pg-backup] RESULT ${JSON.stringify(result)}`);
}

/**
 * Entrypoint of the Postgres backup one-shot (`pnpm start:backup`), run by the
 * box's host cron at 03:00 and 15:00 UTC (`backup-cron.sh`).
 *
 * The alert is the RESULT line below: the cron posts it to features-service,
 * and dashboard v2 Monitoring > Box > Watchdogs turns red when a database got
 * no backup, or when no run reported for 3x the cadence. The Sentry cron
 * check-in stays as a second trace, but nobody reads Sentry: it had been red on
 * every run since 2026-10-30 (3 databases failing) and the 3.5-day hang of
 * 2026-11-03 changed nothing there (BACKUP-HANG-1106).
 */
async function main(): Promise<void> {
  if (!process.env.SENTRY_DSN) {
    throw new Error(
      "SENTRY_DSN is required — a backup run must leave a trace of how it ended"
    );
  }

  const settings = loadSettings();

  // Last-resort guard: whatever hangs (an R2 call, the process itself), the run
  // ends 10 min after its budget. Exiting stops the container, which kills any
  // pg_dump still running and so releases its locks (BACKUP-HANG-1106).
  setTimeout(() => {
    const message = `pg-backup: run exceeded its ${settings.runTimeoutMinutes} min budget + 10 min grace; killed`;
    console.error(`[pg-backup] ${message}`);
    printResult(null, message);
    Sentry.captureException(new Error(message));
    void Sentry.flush(5000).finally(() => process.exit(1));
  }, (settings.runTimeoutMinutes + 10) * 60_000).unref();

  const monitorConfig = {
    schedule: { type: "crontab" as const, value: settings.cronSchedule },
    checkinMargin: 60,
    maxRuntime: settings.runTimeoutMinutes,
    timezone: "Etc/UTC",
  };

  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: settings.monitorSlug, status: "in_progress" },
    monitorConfig
  );

  let summary;
  try {
    summary = await runBackupJob({ settings });
  } catch (error) {
    printResult(null, error instanceof Error ? error.message : String(error));
    Sentry.captureException(error);
    Sentry.captureCheckIn(
      { checkInId, monitorSlug: settings.monitorSlug, status: "error" },
      monitorConfig
    );
    throw error;
  }

  printResult(summary, null);
  const failed = summary.databases.filter((outcome) => outcome.status === "failed");
  for (const outcome of failed) {
    Sentry.captureException(new Error(`pg-backup failed for ${outcome.database}: ${outcome.error}`));
  }

  Sentry.captureCheckIn(
    {
      checkInId,
      monitorSlug: settings.monitorSlug,
      status: failed.length > 0 ? "error" : "ok",
    },
    monitorConfig
  );

  console.log(
    `[pg-backup] run ${summary.stamp} complete — ${summary.okCount} ok, ${summary.failedCount} failed`
  );

  if (failed.length > 0) {
    throw new Error(
      `pg-backup: ${failed.length}/${summary.databases.length} database(s) failed: ` +
        failed.map((outcome) => outcome.database).join(", ")
    );
  }
}

main()
  .then(async () => {
    await Sentry.flush(5000);
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("[pg-backup] run failed:", error);
    await Sentry.flush(5000);
    process.exit(1);
  });
