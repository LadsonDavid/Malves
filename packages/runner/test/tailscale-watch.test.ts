import { afterEach, describe, expect, it, vi } from "vitest";
import { watchForTailscale } from "../src/tailscale-watch.js";

afterEach(() => vi.useRealTimers());

describe("watching for Tailscale to come up", () => {
  it("calls back once, with the address, when Tailscale appears after serve started without it", () => {
    vi.useFakeTimers();
    let address: string | undefined;
    const up = vi.fn();
    watchForTailscale(() => address, up, 10_000);

    vi.advanceTimersByTime(30_000);
    expect(up).not.toHaveBeenCalled();

    address = "100.1.2.3";
    vi.advanceTimersByTime(10_000);
    expect(up).toHaveBeenCalledExactlyOnceWith("100.1.2.3");

    // It stops watching once it has spoken.
    vi.advanceTimersByTime(60_000);
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("can be stopped, and then never calls back", () => {
    vi.useFakeTimers();
    let address: string | undefined;
    const up = vi.fn();
    const stop = watchForTailscale(() => address, up, 10_000);
    stop();
    address = "100.1.2.3";
    vi.advanceTimersByTime(60_000);
    expect(up).not.toHaveBeenCalled();
  });
});
