import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock } from "../src/system.js";

describe("runner lock", () => {
  it("refuses a second runner, and replaces a lock left from an earlier boot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "malves-lock-"));
    const release = acquireLock(dir);
    expect(() => acquireLock(dir)).toThrow(/Another malves runner/);
    release();

    // Our own (live) pid, but written before the computer last started: stale.
    writeFileSync(path.join(dir, "runner.lock"), `${process.pid} 0`);
    const again = acquireLock(dir);
    expect(readFileSync(path.join(dir, "runner.lock"), "utf8")).toMatch(/^\d+ \d+$/);
    again();
  });
});
