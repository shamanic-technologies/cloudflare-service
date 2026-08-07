import { deleteFromR2, listR2Objects } from "../lib/r2-client.js";
import type { R2Config, R2ListedObject } from "../lib/r2-client.js";

/**
 * Retention for the R2 dump archive. Dumps accumulate forever otherwise, and R2
 * charges for storage (egress is free, so restoring costs nothing).
 *
 * A "backup" is a group of objects sharing one timestamped basename:
 *   pg-backups/<db>/<stamp>.dump
 *   pg-backups/<db>/<stamp>.toc.txt
 *   pg-backups/<db>/<stamp>.manifest.json
 * Groups are pruned whole, never partially — a dump without its manifest is not
 * a backup, it is a mystery.
 */

export interface BackupGroup {
  stamp: string;
  objects: R2ListedObject[];
}

export function groupBackups(objects: R2ListedObject[]): BackupGroup[] {
  const groups = new Map<string, R2ListedObject[]>();

  for (const object of objects) {
    const filename = object.key.split("/").pop() ?? object.key;
    const stamp = filename.split(".")[0];
    if (!stamp) continue;
    const bucket = groups.get(stamp);
    if (bucket) bucket.push(object);
    else groups.set(stamp, [object]);
  }

  return [...groups.entries()]
    .map(([stamp, groupObjects]) => ({ stamp, objects: groupObjects }))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * Which groups to delete. Newest-first ordering is assumed (groupBackups).
 * The `minKeep` newest groups are never deleted regardless of age, so a stale
 * job or a long outage can never leave the archive empty.
 */
export function selectExpiredGroups(
  groups: BackupGroup[],
  params: { now: Date; retentionDays: number; minKeep: number }
): BackupGroup[] {
  const cutoffMs = params.now.getTime() - params.retentionDays * 24 * 60 * 60 * 1000;

  return groups.slice(params.minKeep).filter((group) => {
    const newest = group.objects.reduce<number>((max, object) => {
      const ms = object.lastModified ? object.lastModified.getTime() : 0;
      return ms > max ? ms : max;
    }, 0);
    // An object with no lastModified is never pruned on age we cannot read.
    return newest !== 0 && newest < cutoffMs;
  });
}

export interface PruneResult {
  database: string;
  deletedGroups: string[];
  deletedObjects: number;
  keptGroups: number;
}

export async function pruneDatabaseBackups(
  r2Config: R2Config,
  params: { database: string; prefix: string; now: Date; retentionDays: number; minKeep: number }
): Promise<PruneResult> {
  const objects = await listR2Objects(r2Config, `${params.prefix}/${params.database}/`);
  const groups = groupBackups(objects);
  const expired = selectExpiredGroups(groups, params);

  let deletedObjects = 0;
  for (const group of expired) {
    for (const object of group.objects) {
      await deleteFromR2(r2Config, object.key);
      deletedObjects += 1;
    }
  }

  return {
    database: params.database,
    deletedGroups: expired.map((group) => group.stamp),
    deletedObjects,
    keptGroups: groups.length - expired.length,
  };
}
