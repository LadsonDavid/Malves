import { describe, expect, it } from "vitest";
import type { Desktop } from "../src/adapters/assistant/desktop.js";
import { RemoteScreen } from "../src/adapters/screen/remote.js";

describe("your screen on the phone", () => {
  it("says on the computer when a phone starts watching or takes control, once per stretch", async () => {
    const did: string[] = [];
    const notices: string[] = [];
    let now = 1_000_000;
    let loads = 0;
    const desktop: Desktop = {
      screenshot: async () => ({ jpeg: "", width: 1, height: 1 }),
      preview: async () => ({ jpeg: "AAAA", width: 1000, height: 562 }),
      click: async () => {},
      type: async (t) => void did.push(`type ${t}`),
      keys: async (k) => void did.push(`keys ${k}`),
      mouse: async () => ({ x: 0, y: 0 }),
      activeTitle: async () => "",
      point: async (x, y, b) => void did.push(`${b} ${x},${y}`),
      scroll: async (n) => void did.push(`scroll ${n}`),
      raw: async () => ({ width: 2, height: 2, rgba: new Uint8Array(16) }),
    };
    const screen = new RemoteScreen({
      load: async () => {
        loads += 1;
        return desktop;
      },
      notice: (t) => notices.push(t),
      now: () => now,
    });

    expect(await screen.frame()).toMatchObject({ width: 1000 });
    now += 5_000;
    await screen.frame();
    expect(notices).toEqual(["Your phone is watching this screen."]);
    now += 60_000;
    await screen.frame();
    expect(notices).toHaveLength(2);

    await screen.input({ action: "click", x: 0.5, y: 0.25 });
    await screen.input({ action: "right", x: 0.1, y: 0.9 });
    await screen.input({ action: "scroll", lines: -5 });
    await screen.input({ action: "type", text: "hello" });
    await screen.input({ action: "keys", keys: "ctrl+s" });
    expect(did).toEqual([
      "left 0.5,0.25",
      "right 0.1,0.9",
      "scroll -5",
      "type hello",
      "keys ctrl+s",
    ]);
    expect(notices.at(-1)).toBe("Your phone is controlling this computer.");
    expect(notices.filter((n) => n.includes("controlling"))).toHaveLength(1);
    await expect(screen.input({ action: "click" })).rejects.toThrow(/needs x and y/);
    // nut.js loads once.
    expect(loads).toBe(1);
  });
});
