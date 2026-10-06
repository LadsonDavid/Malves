import { describe, expect, it } from "vitest";
import type { Desktop } from "../src/adapters/assistant/desktop.js";
import { commandRisk, Handover, type HandoverState } from "../src/adapters/assistant/handover.js";

describe("handover", () => {
  it("sorts commands: looking and tests/builds run alone, everything else asks", () => {
    expect(commandRisk("git status")).toBe("look");
    expect(commandRisk("git diff --stat")).toBe("look");
    expect(commandRisk("node --version")).toBe("look");
    expect(commandRisk("pnpm test")).toBe("low");
    expect(commandRisk("npm run build")).toBe("low");
    expect(commandRisk("cargo test")).toBe("low");
    expect(commandRisk("git push")).toBe("ask");
    expect(commandRisk("rm -rf dist")).toBe("ask");
    expect(commandRisk("pnpm add left-pad")).toBe("ask");
    // Anything chained, piped, redirected or using variables can hide another command.
    expect(commandRisk("git status; rm -rf .")).toBe("ask");
    expect(commandRisk("pnpm test && git push")).toBe("ask");
    expect(commandRisk("cat secrets > out.txt")).toBe("ask");
    expect(commandRisk("git log $(rm x)")).toBe("ask");
    expect(commandRisk("")).toBe("ask");
  });

  it("ends when he unlocks the computer after it was locked, or when time is up", async () => {
    const seen: HandoverState[] = [];
    let locked = false;
    const h = new Handover({
      onChange: (s) => seen.push(s),
      locked: async () => locked,
      pollMs: 60_000,
    });
    h.start();
    await h.check();
    expect(h.state.active).toBe(true); // unlocked from the start: he hasn't left yet
    locked = true;
    await h.check();
    expect(h.state.active).toBe(true);
    locked = false;
    await h.check();
    expect(h.state).toEqual({ active: false, reason: "You're back at the computer." });

    const timed = new Handover({ onChange: () => {}, maxMs: -1, pollMs: 60_000 });
    timed.start();
    await timed.check();
    expect(timed.state).toEqual({ active: false, reason: "Four hours are up." });
    expect(seen.map((s) => s.active)).toEqual([true, false]);
  });
  it("ends when he moves the mouse, but not when Malves does", async () => {
    let at = { x: 10, y: 10 };
    const desktop = { mouse: async () => at } as unknown as Desktop;
    const h = new Handover({ onChange: () => {}, desktop: async () => desktop, pollMs: 60_000 });
    h.start();
    await h.check(); // first look: remembers where the mouse is
    h.noteOwnInput();
    at = { x: 500, y: 300 }; // Malves clicked
    await h.check();
    expect(h.state.active).toBe(true);
    await h.check();
    expect(h.state.active).toBe(true);
    // Five seconds later, the mouse moves again: that's him.
    (h as unknown as { ownInputAt: number }).ownInputAt = Date.now() - 5_000;
    at = { x: 501, y: 300 };
    await h.check();
    expect(h.state).toEqual({ active: false, reason: "You're back at the computer." });
  });
});
