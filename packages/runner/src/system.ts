import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Clock, Ids } from "@malves/core";

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export const randomIds: Ids = {
  next: (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`,
};

export function dataDir(): string {
  const dir = process.env.MALVES_HOME ?? path.join(homedir(), ".malves");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * One runner per data directory. A second one would see the first one's
 * active tasks as abandoned and mark them failed.
 */
export function acquireLock(dir: string): () => void {
  const file = path.join(dir, "runner.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
      if (isAlive(pid)) throw new Error(`Another malves runner is using ${dir} (pid ${pid}).`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not lock ${dir}`);
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** "90s", "10m", "1h", or plain milliseconds. */
export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`Not a duration: ${text}`);
  const n = Number(match[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "ms"] ?? 1;
  const ms = n * unit;
  if (ms <= 0) throw new Error("Duration must be positive");
  return ms;
}
