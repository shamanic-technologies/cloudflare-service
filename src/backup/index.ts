import "../instrument.js";
import * as Sentry from "@sentry/node";
import { loadSettings } from "./config.js";
import { runBackupJob } from "./run.js";

/**
 * Entrypoint of the daily Postgres backup cron (a separate Railway service on
 * this same repo, started with `pnpm start:backup`).
 *
 * Alerting is a Sentry cron monitor check-in, which covers BOTH failure modes
 * that matter: a run that errors (status "error") and a run that never happened
 * at all (Sentry raises a missed check-in against the declared schedule). A
 * backup that fails silently is worse than no backup, so a missing SENTRY_DSN
 * aborts before anything runs rather than backing up into the void.
 */
async function main(): Promise<void> {
  if (!process.env.SENTRY_DSN) {
    throw new Error(
      "SENTRY_DSN is required — it is the only channel that reports a failed or missed backup run"
    );
  }

  const settings = loadSettings();
  const monitorConfig = {
    schedule: { type: "crontab" as const, value: settings.cronSchedule },
    checkinMargin: 60,
    maxRuntime: 6 * 60,
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
    Sentry.captureException(error);
    Sentry.captureCheckIn(
      { checkInId, monitorSlug: settings.monitorSlug, status: "error" },
      monitorConfig
    );
    throw error;
  }

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
