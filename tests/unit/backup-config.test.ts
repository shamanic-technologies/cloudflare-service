import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BACKUP_BUCKET_KEY,
  BACKUP_CALLER_SERVICE,
  DEFAULT_DB_KEY_PREFIX,
  PUBLIC_BUCKET_KEY,
  databaseNameFromProvider,
  discoverTargets,
  loadBackupR2Config,
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

  describe("caller name toward key-service (BACKUP-CALLER-NAME-1128)", () => {
    // key-service knows `pg-backup` as an own job allowed to read exactly these keys;
    // any other key under that name alerts as a stranger borrowing the name.
    const ALLOWED_EXACT = new Set([
      "cloudflare-r2-access-key-id",
      "cloudflare-r2-secret-access-key",
      "cloudflare-r2-account-id",
      "cloudflare-r2-private-bucket-name",
    ]);

    function stubRecording() {
      const calls: { url: string; caller: string }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const headers = init.headers as Record<string, string>;
          calls.push({ url, caller: headers["X-Caller-Service"] });
          const body = url.endsWith("/platform-keys")
            ? { keys: [{ provider: "pg-backup-dsn-runs-service" }, { provider: "openai" }] }
            : (() => {
                const provider = url.split("/keys/platform/")[1].replace("/decrypt", "");
                return { provider, key: `postgres://user@host/${provider}` };
              })();
          return { ok: true, status: 200, json: async () => body, text: async () => "" };
        })
      );
      return calls;
    }

    it("sends X-Caller-Service: pg-backup on the platform key list and every decrypt", async () => {
      const calls = stubRecording();
      expect(BACKUP_CALLER_SERVICE).toBe("pg-backup");

      await discoverTargets(loadSettings());
      await loadBackupR2Config();

      expect(calls.some((c) => c.url.endsWith("/platform-keys"))).toBe(true);
      expect(calls.filter((c) => c.url.includes("/decrypt")).length).toBe(5);
      for (const c of calls) expect(c.caller).toBe("pg-backup");
    });

    it("decrypts only keys key-service allows the pg-backup name to read", async () => {
      const calls = stubRecording();
      await discoverTargets(loadSettings());
      await loadBackupR2Config();

      const decrypted = calls
        .filter((c) => c.url.includes("/decrypt"))
        .map((c) => c.url.split("/keys/platform/")[1].replace("/decrypt", ""));
      for (const provider of decrypted) {
        expect(provider.startsWith("pg-backup-dsn-") || ALLOWED_EXACT.has(provider)).toBe(true);
      }
    });
  });

  describe("loadBackupR2Config", () => {
    function stubDecrypt(missing: string[] = []) {
      const asked: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const provider = url.split("/keys/platform/")[1].replace("/decrypt", "");
          asked.push(provider);
          if (missing.includes(provider)) {
            return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ provider, key: provider }),
            text: async () => "",
          };
        })
      );
      return asked;
    }

    it("resolves the PRIVATE bucket key, never the public one", async () => {
      const asked = stubDecrypt();
      const config = await loadBackupR2Config();
      expect(BACKUP_BUCKET_KEY).toBe("cloudflare-r2-private-bucket-name");
      expect(config.bucketName).toBe("cloudflare-r2-private-bucket-name");
      expect(config.accessKeyId).toBe("cloudflare-r2-access-key-id");
      expect(asked).not.toContain("cloudflare-r2-bucket-name");
      expect(asked).not.toContain(PUBLIC_BUCKET_KEY);
      expect(asked).not.toContain("cloudflare-r2-public-domain");
      expect(config).not.toHaveProperty("publicDomain");
    });

    it("fails loud when the private bucket key is missing, no public fallback", async () => {
      const asked = stubDecrypt(["cloudflare-r2-private-bucket-name"]);
      await expect(loadBackupR2Config()).rejects.toThrow(/not configured/);
      expect(asked).not.toContain("cloudflare-r2-bucket-name");
    });
  });
});
