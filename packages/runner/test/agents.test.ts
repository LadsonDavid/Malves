import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { permissionDecision } from "../src/adapters/acp/host.js";
import { knownAgents } from "../src/agents.js";

describe("known agents", () => {
  // `npx` is `npx.cmd` on Windows, which can't be started without a shell.
  it.each(["claude", "codex"])("%s starts as `node <installed script>`, never npx", (name) => {
    const agent = knownAgents().get(name);
    expect(agent?.program).toBe(process.execPath);
    const script = agent?.args[0] ?? "";
    expect(script).toMatch(/[\\/]dist[\\/]index\.js$/);
    expect(existsSync(script)).toBe(true);
  });
});

describe("permission requests", () => {
  const request = (kinds: Array<"allow_once" | "allow_always" | "reject_once" | "reject_always">) =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "Edit x", kind: "edit" },
      options: kinds.map((kind) => ({ optionId: kind, name: kind, kind })),
    }) as Parameters<typeof permissionDecision>[0];

  it("never offers 'allow always': every call must come back to the user", () => {
    const decision = permissionDecision(
      request(["allow_once", "allow_always", "reject_once", "reject_always"]),
    );
    expect(decision.choices.map((c) => c.id)).toEqual([
      "allow_once",
      "reject_once",
      "reject_always",
    ]);
  });
});
