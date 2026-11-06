import { describe, expect, it, vi } from "vitest";
import type { Desktop } from "../src/adapters/assistant/desktop.js";
import { hashDistance, perceptualHash } from "../src/adapters/computer/hash.js";
import { ComputerOperator } from "../src/adapters/computer/operator.js";

describe("computer operator - hash", () => {
  it("computes perceptual hash and hamming distance", () => {
    const h1 = perceptualHash("sample screen data 12345");
    const h2 = perceptualHash("sample screen data 12345");
    expect(h1).toBe(h2);
    expect(hashDistance(h1, h2)).toBe(0);

    const buf1 = new Uint8Array(64).fill(255, 0, 32);
    const buf2 = new Uint8Array(64).fill(255, 0, 32);
    const hBuf1 = perceptualHash(buf1);
    const hBuf2 = perceptualHash(buf2);
    expect(hBuf1).toBe(hBuf2);
    expect(hashDistance(hBuf1, hBuf2)).toBe(0);

    const buf3 = new Uint8Array(64).fill(255, 32, 64);
    const hBuf3 = perceptualHash(buf3);
    expect(hashDistance(hBuf1, hBuf3)).toBeGreaterThan(0);
  });
});

describe("computer operator - operator contract", () => {
  function makeFakeDesktop(initialTitle = "Visual Studio Code - Malves") {
    let title = initialTitle;
    let screenJpeg = "screen_image_content_initial_state_123456789";
    const calls: { method: string; args: unknown[] }[] = [];

    const desktop: Desktop = {
      async screenshot() {
        return { jpeg: screenJpeg, width: 1920, height: 1080 };
      },
      async preview() {
        return { jpeg: screenJpeg, width: 480, height: 270 };
      },
      async activeTitle() {
        return title;
      },
      async click(x: number, y: number) {
        calls.push({ method: "click", args: [x, y] });
      },
      async type(text: string) {
        calls.push({ method: "type", args: [text] });
      },
      async keys(combo: string) {
        calls.push({ method: "keys", args: [combo] });
      },
      async mouse() {
        return { x: 100, y: 100 };
      },
      async raw() {
        return { width: 1920, height: 1080, rgba: new Uint8Array(100) };
      },
      async point(x: number, y: number, button: "move" | "left" | "double" | "right") {
        calls.push({ method: "point", args: [x, y, button] });
      },
      async scroll(lines: number) {
        calls.push({ method: "scroll", args: [lines] });
      },
    };

    return {
      desktop,
      calls,
      setTitle: (t: string) => {
        title = t;
      },
      setScreen: (data: string) => {
        screenJpeg = data;
      },
    };
  }

  it("takes snapshots and executes actions with matching frameId", async () => {
    const fake = makeFakeDesktop();
    const operator = new ComputerOperator({ desktop: fake.desktop });

    const snap = await operator.snapshot();
    expect(snap.frameId).toMatch(/^f_/);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);

    // Perform click
    fake.setScreen("screen_image_content_state_after_click_updated_987654321");
    const result = await operator.act({ kind: "click", x: 200, y: 300 }, snap.frameId);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ method: "click", args: [200, 300] });
  });

  it("enforces frame rule: rejects act if screen changed since snapshot", async () => {
    const fake = makeFakeDesktop();
    const operator = new ComputerOperator({
      desktop: fake.desktop,
      hashThreshold: 2,
    });

    const snap = await operator.snapshot();
    // Screen changed drastically under the agent
    fake.setScreen("completely_different_screen_unexpected_dialog_popped_up_00000");

    const result = await operator.act({ kind: "click", x: 100, y: 100 }, "f_stale_or_mismatch");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Screen changed since snapshot");
    expect(result.changed).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("enforces take-over handshake: pauses agent input while user is active", async () => {
    const fake = makeFakeDesktop();
    const operator = new ComputerOperator({
      desktop: fake.desktop,
      userPauseMs: 50,
    });

    const snap = await operator.snapshot();

    // User touches mouse/keyboard
    operator.notifyUserActivity();
    expect(operator.isUserActive()).toBe(true);

    const resultPaused = await operator.act({ kind: "type", text: "hello" }, snap.frameId);
    expect(resultPaused.ok).toBe(false);
    expect(resultPaused.userActive).toBe(true);
    expect(resultPaused.error).toContain("User is active on the machine");
    expect(fake.calls).toHaveLength(0);

    // Wait until pause duration elapses
    await new Promise((r) => setTimeout(r, 60));
    expect(operator.isUserActive()).toBe(false);

    fake.setScreen("screen_updated_after_typing_test_123");
    const resultResumed = await operator.act({ kind: "type", text: "hello" }, snap.frameId);
    expect(resultResumed.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ method: "type", args: ["hello"] });
  });

  it("enforces off-limits windows: refuses action on password/banking/login windows", async () => {
    const fake = makeFakeDesktop("1Password - Master Password Unlock");
    const operator = new ComputerOperator({ desktop: fake.desktop });

    const snap = await operator.snapshot();
    const result = await operator.act({ kind: "click", x: 100, y: 100 }, snap.frameId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Off-limits window");
    expect(fake.calls).toHaveLength(0);
  });

  it("checks after acting: halts if no change detected twice consecutively", async () => {
    const fake = makeFakeDesktop();
    const operator = new ComputerOperator({ desktop: fake.desktop });

    const snap = await operator.snapshot();
    // Do not change screen: simulates clicking dead area
    const res1 = await operator.act({ kind: "click", x: 50, y: 50 }, snap.frameId);
    expect(res1.ok).toBe(true);
    expect(res1.changed).toBe(false);

    // Second action with no screen change
    const res2 = await operator.act({ kind: "click", x: 50, y: 50 }, res1.frameId);
    expect(res2.ok).toBe(false);
    expect(res2.changed).toBe(false);
    expect(res2.error).toContain("No change detected on screen twice in a row");
  });

  it("asks user confirmation on destructive action in confirming window", async () => {
    const fake = makeFakeDesktop("Confirm Delete Database Dialog");
    let asked = false;
    const operator = new ComputerOperator({
      desktop: fake.desktop,
      askUser: async (_q) => {
        asked = true;
        return false; // User declines
      },
    });

    const snap = await operator.snapshot();
    const result = await operator.act({ kind: "click", x: 300, y: 400 }, snap.frameId);

    expect(asked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Action declined by user.");
    expect(fake.calls).toHaveLength(0);
  });
});
