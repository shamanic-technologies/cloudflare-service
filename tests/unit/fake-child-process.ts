import { EventEmitter } from "events";
import { PassThrough } from "stream";

/**
 * Minimal stand-in for a spawned child process: real streams, controllable exit.
 * Lets the backup tests drive pg_dump / pg_restore behaviour without Postgres.
 */
export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  spawnfile: string;

  constructor(spawnfile: string) {
    super();
    this.spawnfile = spawnfile;
    // Consume stdin by default so writers are never blocked.
    this.stdin.resume();
  }

  finish(code: number): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, null));
  }
}

export interface FakeSpawnPlan {
  /** Called with (file, args) — return the child to hand back. */
  (file: string, args: string[]): FakeChild;
}

export function makeFakeSpawn(plan: FakeSpawnPlan) {
  const calls: { file: string; args: string[] }[] = [];
  const spawnFn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    return plan(file, args);
  }) as unknown as typeof import("child_process").spawn;
  return { spawnFn, calls };
}
