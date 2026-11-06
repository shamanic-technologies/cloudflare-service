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

  killedWith: string | null = null;
  private closed = false;

  /** Like a real kill: the process dies, its pipes close, "close" reports the signal. */
  kill(signal: string = "SIGTERM"): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.killedWith = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", null, signal));
    return true;
  }

  finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
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
