import { describe, it, expect } from "vitest";
import { groupBackups, selectExpiredGroups } from "../../src/backup/retention.js";
import type { R2ListedObject } from "../../src/lib/r2-client.js";

const NOW = new Date("2026-08-07T03:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function backup(stamp: string, ageDays: number): R2ListedObject[] {
  const at = daysAgo(ageDays);
  return [".dump", ".toc.txt", ".manifest.json"].map((suffix) => ({
    key: `pg-backups/runs-service/${stamp}${suffix}`,
    size: 100,
    lastModified: at,
  }));
}

describe("groupBackups", () => {
  it("groups the dump, toc and manifest of one backup together, newest first", () => {
    const groups = groupBackups([
      ...backup("2026-08-05T030000Z", 2),
      ...backup("2026-08-07T030000Z", 0),
    ]);

    expect(groups.map((g) => g.stamp)).toEqual(["2026-08-07T030000Z", "2026-08-05T030000Z"]);
    expect(groups[0].objects).toHaveLength(3);
  });
});

describe("selectExpiredGroups", () => {
  const params = { now: NOW, retentionDays: 30, minKeep: 7 };

  it("deletes groups past the retention window", () => {
    const groups = groupBackups([
      ...Array.from({ length: 10 }, (_, i) => backup(`2026-08-0${i}T030000Z`, i)).flat(),
      ...backup("2026-05-01T030000Z", 98),
    ]);

    const expired = selectExpiredGroups(groups, params);
    expect(expired.map((g) => g.stamp)).toEqual(["2026-05-01T030000Z"]);
  });

  it("keeps the minKeep newest backups even when all of them are older than the window", () => {
    const groups = groupBackups(
      Array.from({ length: 9 }, (_, i) => backup(`2026-01-0${i + 1}T030000Z`, 200 + i)).flat()
    );

    const expired = selectExpiredGroups(groups, params);
    // 9 groups, 7 protected by minKeep, 2 oldest expire.
    expect(expired).toHaveLength(2);
    expect(expired.map((g) => g.stamp)).toEqual(["2026-01-02T030000Z", "2026-01-01T030000Z"]);
  });

  it("never deletes anything when there are fewer backups than minKeep", () => {
    const groups = groupBackups(
      Array.from({ length: 3 }, (_, i) => backup(`2025-01-0${i + 1}T030000Z`, 500)).flat()
    );
    expect(selectExpiredGroups(groups, params)).toEqual([]);
  });

  it("does not prune an object whose age is unknown", () => {
    const groups = groupBackups([
      ...Array.from({ length: 8 }, (_, i) => backup(`2026-08-0${i}T030000Z`, i)).flat(),
      { key: "pg-backups/runs-service/2020-01-01T000000Z.dump", size: 1, lastModified: null },
    ]);

    expect(selectExpiredGroups(groups, params)).toEqual([]);
  });
});
