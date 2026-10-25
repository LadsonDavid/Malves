import { describe, expect, it } from "vitest";
import { startLagMonitor } from "../src/loop-lag.js";

describe("the main loop's lag monitor", () => {
  it("says so when the loop was stuck, and stays quiet when it wasn't", async () => {
    const said: string[] = [];
    const stop = startLagMonitor({ say: (l) => said.push(l), everyMs: 100, thresholdMs: 200 });
    await new Promise((r) => setTimeout(r, 250));
    expect(said).toEqual([]);

    const until = Date.now() + 400;
    while (Date.now() < until) {
      // A loop that never lets go, like a long synchronous read.
    }
    await new Promise((r) => setTimeout(r, 250));
    stop();
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toMatch(/main loop was stuck for 0\.[3-9]|1\./);
  });
});
