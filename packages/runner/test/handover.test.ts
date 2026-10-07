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
    // PowerShell runs what's in brackets: hidden commands always ask.
    expect(commandRisk("git log (Remove-Item C:\\stuff -Recurse)")).toBe("ask");
    expect(commandRisk("git log @(rm x)")).toBe("ask");
    expect(commandRisk('cat "a.txt"')).toBe("ask");
    // git branch only lists by itself.
    expect(commandRisk("git branch")).toBe("look");
    expect(commandRisk("git branch -a")).toBe("look");
    expect(commandRisk("git branch -D main")).toBe("ask");
    expect(commandRisk("git branch new-idea")).toBe("ask");
    expect(commandRisk("git diff --output=x.txt")).toBe("ask");
    // Reading outside the project, or secrets inside it, asks.
    expect(commandRisk("cat src/index.ts")).toBe("look");
    expect(commandRisk("cat .env")).toBe("ask");
    expect(commandRisk("type C:\\Users\\Snoba\\.ssh\\ssh-key-2026-10-05.key")).toBe("ask");
    expect(commandRisk("cat ../other/notes.md")).toBe("ask");
    expect(commandRisk("cat ~/.ssh/id_ed25519")).toBe("ask");
    expect(commandRisk("type LLM-keys.txt")).toBe("ask");
    expect(commandRisk("get-content config/secrets.json")).toBe("ask");
  });

  it("ends only on Stop or after four hours; touching the computer doesn't end it", async () => {
    const seen: HandoverState[] = [];
    let at = { x: 10, y: 10 };
    const desktop = { mouse: async () => at } as unknown as Desktop;
    const h = new Handover({
      onChange: (s) => seen.push(s),
      desktop: async () => desktop,
      pollMs: 60_000,
    });
    h.start();
    await h.check();
    at = { x: 500, y: 300 }; // he moved the mouse: he may be at the desk, watching
    await h.check();
    expect(h.state.active).toBe(true);
    h.stop("You took it back.");
    expect(h.state).toEqual({ active: false, reason: "You took it back." });

    const timed = new Handover({ onChange: () => {}, maxMs: -1, pollMs: 60_000 });
    timed.start();
    await timed.check();
    expect(timed.state).toEqual({ active: false, reason: "Four hours are up." });
    expect(seen.map((x) => x.active)).toEqual([true, false]);
  });
});
