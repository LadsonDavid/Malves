import { existsSync } from "node:fs";
import { command } from "@malves/core";
import { describe, expect, it } from "vitest";
import { permissionDecision } from "../src/adapters/acp/host.js";
import { AgentStatus } from "../src/agent-status.js";
import { knownAgents, signInMessage } from "../src/agents.js";

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

describe("agent status", () => {
  const agents = new Map([
    ["claude", command("claude-program")],
    ["demo", command("demo-program")],
  ]);

  it("starts as 'checking', then shows what each agent answered", async () => {
    const status = new AgentStatus(agents, async (c) =>
      c.program === "claude-program" ? { state: "needs_sign_in" } : { state: "ready" },
    );
    expect(status.list().map((a) => a.state)).toEqual(["checking", "checking"]);
    await status.checkAll();
    expect(status.list()).toEqual([
      {
        name: "claude",
        label: "Claude",
        state: "needs_sign_in",
        hint: "On the computer, run `claude` in a terminal and type /login.",
      },
      { name: "demo", label: "Demo", state: "ready" },
    ]);
  });

  it("explains why an agent isn't available", async () => {
    const status = new AgentStatus(agents, async () => ({
      state: "unavailable",
      detail: "It didn't respond in time.",
    }));
    await status.checkAll();
    expect(status.list()[0]?.hint).toBe("It didn't respond in time.");
  });

  it("tells listeners only when something actually changed", async () => {
    const status = new AgentStatus(agents, async () => ({ state: "ready" }));
    await status.checkAll();
    const seen: string[][] = [];
    status.subscribe((list) => seen.push(list.map((a) => a.state)));
    status.set("claude", "ready");
    status.set("claude", "needs_sign_in");
    status.set("nobody", "ready");
    expect(seen).toEqual([["needs_sign_in", "ready"]]);
  });

  it("runs one check at a time; a second request shares it", async () => {
    let probes = 0;
    const status = new AgentStatus(agents, async () => {
      probes += 1;
      return { state: "ready" };
    });
    await Promise.all([status.checkAll(), status.checkAll()]);
    expect(probes).toBe(2);
  });

  it("phrases the sign-in message in plain words", () => {
    expect(signInMessage("claude")).toBe(
      "Claude isn't signed in on your computer. On the computer, run `claude` in a terminal and type /login. Then try again.",
    );
  });
});
