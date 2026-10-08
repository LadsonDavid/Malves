import { describe, expect, it } from "vitest";
import { humanize, humanizeSentence } from "../src/adapters/assistant/humanize.js";

describe("how Malves sounds", () => {
  it("drops chatbot openers, closers and flattery", () => {
    expect(
      humanize(
        "Great question! Codex finished the footer. I hope this helps! Let me know if you need anything else.",
      ),
    ).toBe("Codex finished the footer.");
    expect(humanize("Certainly! Claude is still on the tests.")).toBe(
      "Claude is still on the tests.",
    );
    expect(humanize("Sure, I'll check. You're absolutely right about that. It failed.")).toBe(
      "I'll check. It failed.",
    );
    expect(humanize("Sure.")).toBe("");
  });

  it("takes out em dashes, curly quotes, emojis and markdown", () => {
    expect(humanize("The build failed — two tests 🚀 broke on **footer.tsx**.")).toBe(
      "The build failed, two tests broke on footer.tsx.",
    );
    expect(humanize("- He said “ship it” and `pnpm test` passed.")).toBe(
      'He said "ship it" and pnpm test passed.',
    );
  });

  it("swaps filler for plain words, but never in a read-back", () => {
    expect(
      humanize(
        "In order to fix it, Codex reran the tests. Additionally, it is important to note that lint passed.",
      ),
    ).toBe("To fix it, Codex reran the tests. Also, lint passed.");
    const readBack = 'Start Claude in malves: "in order to ship, utilize the old API"?';
    expect(humanizeSentence(readBack, { words: false })).toBe(readBack);
  });

  it("leaves Tamil and ordinary sentences alone", () => {
    expect(humanize("சரி, கோடெக்ஸ் டெஸ்ட் முடிந்தது. Codex la test pass aachu.")).toBe(
      "சரி, கோடெக்ஸ் டெஸ்ட் முடிந்தது. Codex la test pass aachu.",
    );
  });
});
