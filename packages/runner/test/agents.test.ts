import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { command } from "@malves/core";
import { describe, expect, it } from "vitest";
import { permissionDecision } from "../src/adapters/acp/host.js";
import { AgentStatus } from "../src/agent-status.js";
import { type AgentProfile, agentProfiles, knownAgents, signInMessage } from "../src/agents.js";

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
  const agents = new Map<string, AgentProfile>([
    [
      "claude",
      {
        label: "Claude",
        command: command("claude-program"),
        signInHint: "On the computer, run `claude` in a terminal and type /login.",
      },
    ],
    ["demo", { label: "Demo", command: command("demo-program"), signInHint: "" }],
  ]);

  it("starts as 'checking', then shows what each agent answered", async () => {
    const status = new AgentStatus(agents, async (name) =>
      name === "claude" ? { state: "needs_sign_in" } : { state: "ready" },
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

  it("a slow agent is usable, marked slow; at most two are checked at once", async () => {
    const many = new Map<string, AgentProfile>(
      ["a", "b", "c", "d", "e"].map((n) => [n, { label: n, command: command(n), signInHint: "" }]),
    );
    let running = 0;
    let most = 0;
    const status = new AgentStatus(many, async (name) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return name === "a"
        ? { state: "unavailable", detail: "It didn't respond in time.", slow: true }
        : { state: "ready" };
    });
    await status.checkAll();
    expect(most).toBe(2);
    expect(status.list()[0]).toEqual({
      name: "a",
      label: "a",
      state: "ready",
      hint: "Slow to start: give it a minute.",
    });
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

  it("an agent that isn't installed is 'not available', without trying to start it", async () => {
    let probes = 0;
    const profiles = new Map<string, AgentProfile>([
      [
        "antigravity",
        {
          label: "Antigravity",
          command: command("agy"),
          signInHint: "",
          missing: "Not installed here.",
        },
      ],
    ]);
    const status = new AgentStatus(profiles, async () => {
      probes += 1;
      return { state: "ready" };
    });
    await status.checkAll();
    expect(status.list()).toEqual([
      {
        name: "antigravity",
        label: "Antigravity",
        state: "unavailable",
        hint: "Not installed here.",
      },
    ]);
    expect(probes).toBe(0);
  });
});

describe("Antigravity", () => {
  const home = (withProgram: boolean) => {
    const dir = mkdtempSync(path.join(tmpdir(), "malves-home-"));
    if (withProgram) {
      const agents = path.join(dir, "agents", "antigravity");
      mkdirSync(agents, { recursive: true });
      const exe = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
      writeFileSync(path.join(agents, exe), "");
    }
    return dir;
  };

  it("is offered, but marked missing, until Google's server is installed", () => {
    expect(agentProfiles(home(false)).get("antigravity")?.missing).toMatch(/isn't installed/);
    expect(agentProfiles(home(true)).get("antigravity")?.missing).toBeUndefined();
  });

  it("only ever signs in with an API key, in its own settings folder", () => {
    const dir = home(true);
    const p = agentProfiles(dir).get("antigravity");
    expect(p?.authMethod).toBe("gemini-api-key");
    expect(p?.requiresEnv).toBe("GEMINI_API_KEY");
    // Its own GEMINI_HOME: it can never see or use the person's Google login.
    expect(p?.env?.GEMINI_HOME).toBe(path.join(dir, "agents", "antigravity", "home"));
  });
});

describe("Cursor profile", () => {
  const exe = process.platform === "win32" ? "agent.exe" : "agent";
  function withPath(files: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "malves-path-"));
    for (const f of files) writeFileSync(path.join(dir, f), "");
    // Also a home folder of its own, so a real ~/.local/bin on this machine doesn't count.
    const saved = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    Object.assign(process.env, { PATH: dir, HOME: dir, USERPROFILE: dir });
    try {
      return { dir, cursor: agentProfiles(dir).get("cursor") };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("uses Cursor's real program with `acp` once it's installed", () => {
    const { dir, cursor } = withPath([exe]);
    expect(cursor?.command).toEqual({ program: path.join(dir, exe), args: ["acp"] });
    expect(cursor?.missing).toBeUndefined();
  });

  it("says how to install it when it isn't there", () => {
    expect(withPath([]).cursor?.missing).toContain("isn't installed");
  });

  it.runIf(process.platform === "win32")("never starts a .cmd wrapper, and says so", () => {
    expect(withPath(["agent.cmd"]).cursor?.missing).toContain("can't start without a shell");
  });
});
