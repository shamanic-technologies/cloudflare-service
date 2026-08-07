import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFAULT_DB_KEY_PREFIX,
  databaseNameFromProvider,
  discoverTargets,
  loadR2Config,
  loadSettings,
  selectDatabaseProviders,
} from "../../src/backup/config.js";

const ORIGINAL_ENV = { ...process.env };

describe("backup config", () => {
  beforeEach(() => {
    process.env.KEY_SERVICE_URL = "http://key-service.test";
    process.env.KEY_SERVICE_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  describe("selectDatabaseProviders", () => {
    it("keeps only prefixed providers and sorts them", () => {
      const providers = [
        "cloudflare-r2-account-id",
        "pg-backup-dsn-runs-service",
        "pg-backup-dsn-billing-service",
        "openai",
        // Bare prefix carries no database name.
        "pg-backup-dsn-",
      ];

      expect(selectDatabaseProviders(providers, DEFAULT_DB_KEY_PREFIX)).toEqual([
        "pg-backup-dsn-billing-service",
        "pg-backup-dsn-runs-service",
      ]);
    });

    it("honours a custom prefix", () => {
      expect(selectDatabaseProviders(["backup-dsn-a", "pg-backup-dsn-b"], "backup-dsn-")).toEqual([
        "backup-dsn-a",
      ]);
    });
  });

  describe("databaseNameFromProvider", () => {
    it("strips the prefix", () => {
      expect(databaseNameFromProvider("pg-backup-dsn-runs-service", DEFAULT_DB_KEY_PREFIX)).toBe(
        "runs-service"
      );
    });

    it("rejects a name that is not R2-key safe", () => {
      expect(() => databaseNameFromProvider("pg-backup-dsn-a/b", DEFAULT_DB_KEY_PREFIX)).toThrow(
        /unusable database name/
      );
    });
  });

  describe("loadSettings", () => {
    it("defaults everything", () => {
      const settings = loadSettings();
      expect(settings.dbKeyPrefix).toBe("pg-backup-dsn-");
      expect(settings.r2Prefix).toBe("pg-backups");
      expect(settings.retentionDays).toBe(30);
      expect(settings.minKeep).toBe(7);
    });

    it("reads overrides from env", () => {
      process.env.BACKUP_RETENTION_DAYS = "14";
      process.env.BACKUP_MIN_KEEP = "3";
      process.env.BACKUP_R2_PREFIX = "dumps";
      const settings = loadSettings();
      expect(settings.retentionDays).toBe(14);
      expect(settings.minKeep).toBe(3);
      expect(settings.r2Prefix).toBe("dumps");
    });

    it("fails loud on a non-numeric retention", () => {
      process.env.BACKUP_RETENTION_DAYS = "forever";
      expect(() => loadSettings()).toThrow(/must be a non-negative integer/);
    });
  });

  describe("discoverTargets", () => {
    function stubKeyService(handler: (url: string) => unknown) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          json: async () => handler(url),
          text: async () => "",
        }))
      );
    }

    it("resolves one DSN per matching platform key", async () => {
      stubKeyService((url) => {
        if (url.endsWith("/platform-keys")) {
          return {
            keys: [
              { provider: "pg-backup-dsn-runs-service" },
              { provider: "pg-backup-dsn-billing-service" },
              { provider: "cloudflare-r2-account-id" },
            ],
          };
        }
        const provider = url.split("/keys/platform/")[1].replace("/decrypt", "");
        return { provider, key: `postgres://user@host/${provider}` };
      });

      const targets = await discoverTargets(loadSettings());

      expect(targets.map((t) => t.name)).toEqual(["billing-service", "runs-service"]);
      expect(targets[0].dsn).toContain("postgres://");
    });

    it("fails loud when no database is configured", async () => {
      stubKeyService(() => ({ keys: [{ provider: "openai" }] }));
      await expect(discoverTargets(loadSettings())).rejects.toThrow(/nothing to back up/);
    });

    it("fails loud when a configured key is not a Postgres DSN", async () => {
      stubKeyService((url) =>
        url.endsWith("/platform-keys")
          ? { keys: [{ provider: "pg-backup-dsn-runs-service" }] }
          : { provider: "x", key: "sk-not-a-dsn" }
      );
      await expect(discoverTargets(loadSettings())).rejects.toThrow(
        /not a Postgres connection string/
      );
    });
  });

  describe("loadR2Config", () => {
    it("reads the same platform keys the HTTP service uses", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => ({
          ok: true,
          status: 200,
          json: async () => ({
            provider: "x",
            key: url.split("/keys/platform/")[1].replace("/decrypt", ""),
          }),
          text: async () => "",
        }))
      );

      const config = await loadR2Config();
      expect(config.accessKeyId).toBe("cloudflare-r2-access-key-id");
      expect(config.bucketName).toBe("cloudflare-r2-bucket-name");
    });
  });
});
