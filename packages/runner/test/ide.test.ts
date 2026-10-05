import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AgentHost, command, createCore, type Notifier } from "@malves/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { IdeBridge } from "../src/adapters/ide/bridge.js";
import { ideControl, resumeCommand } from "../src/adapters/ide/control.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * The IDE bridge, with a fake IDE that speaks exactly what malves' IDE
 * extension does (hello with the code, folders, results, answers).
 */
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-ide-")));
  const site = path.join(dir, "site");
  mkdirSync(site);
  const store = new SqliteStore(path.join(dir, "malves.db"));
  const host: AgentHost = {
    start: () => ({ finished: new Promise(() => {}), cancel: async () => {} }),
  };
  const noPush: Notifier = { questionOpened: async () => {} };
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier: noPush,
    host,
    agents: new Map([["claude", command("x")]]),
    questionTimeoutMs: 60_000,
  });
  const ws = core.workspaces.register("site", site);
  const bridge = new IdeBridge(core, {
    token: "ide-secret-0123456789",
    port: 0,
    agentLabel: () => "Claude",
  });
  const port = await bridge.start();
  cleanup.push(() => store.close());
  cleanup.push(() => bridge.close());
  const control = ideControl(bridge, {
    workspaces: () => core.workspaces.list(),
    workspace: (id) => core.workspaces.get(id),
    changedFiles: (taskId) =>
      taskId === "t-changed" ? { root: site, files: ["a.ts", "b.ts"] } : undefined,
    agentLabel: () => "Claude",
  });
  return { core, bridge, control, port, site, dir, ws };
}

/** A fake IDE window. `reply` decides how it answers each request. */
function ide(
  port: number,
  o: {
    token?: string;
    origin?: string;
    folders: string[];
    reply?: (op: string, args: Record<string, unknown>) => { ok: boolean; message: string };
  },
) {
  const got: Array<Record<string, unknown>> = [];
  let closeCode = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, o.origin ? { origin: o.origin } : {});
  socket.on("error", () => {});
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        type: "hello",
        token: o.token ?? "ide-secret-0123456789",
        app: "Cursor",
        folders: o.folders,
      }),
    ),
  );
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    got.push(message);
    if (message.type === "call") {
      const r = o.reply?.(String(message.op), message.args as Record<string, unknown>) ?? {
        ok: true,
        message: "ok",
      };
      socket.send(JSON.stringify({ type: "result", id: message.id, ...r }));
    }
  });
  socket.on("close", (code) => {
    closeCode = code;
  });
  socket.on("unexpected-response", (_req, res) => {
    closeCode = res.statusCode ?? -1;
  });
  cleanup.push(() => socket.terminate());
  return { socket, got, closed: () => closeCode };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("IDE companion bridge", () => {
  it("lists open IDE windows, matched to your projects (names only), and notices them closing", async () => {
    const s = await setup();
    const changes: number[] = [];
    s.control.onChange(() => changes.push(s.bridge.list().length));
    const window = ide(s.port, { folders: [s.site, path.join(s.dir, "elsewhere")] });
    await waitFor(() => s.bridge.list().length === 1, "the IDE");
    expect(s.control.list()).toEqual([
      {
        id: expect.any(String),
        app: "Cursor",
        projects: [{ name: "site", workspace_id: s.ws.id }, { name: "elsewhere" }],
      },
    ]);
    window.socket.close();
    await waitFor(() => s.bridge.list().length === 0, "the IDE to close");
    expect(changes).toEqual([1, 0]);
  });

  it("refuses the wrong code, and anything coming from a web page", async () => {
    const s = await setup();
    const wrong = ide(s.port, { token: "nope", folders: [] });
    await waitFor(() => wrong.closed() === 4001, "the refusal");
    const page = ide(s.port, { origin: "https://evil.example", folders: [] });
    await waitFor(() => page.closed() !== 0, "the web page refusal");
    expect(page.closed()).toBe(401);
    expect(s.bridge.list()).toEqual([]);
  });

  it("starts the IDE's agent, opens a task's changes, and reopens a conversation in its terminal", async () => {
    const s = await setup();
    const seen: Array<[string, Record<string, unknown>]> = [];
    ide(s.port, {
      folders: [s.site],
      reply: (op, args) => {
        seen.push([op, args]);
        return { ok: true, message: `did ${op}` };
      },
    });
    await waitFor(() => s.bridge.list().length === 1, "the IDE");
    const id = s.bridge.list()[0]?.id ?? "";

    expect(await s.control.agent(id, "fix the footer")).toBe("did agent");
    expect(await s.control.openChanges(id, "t-changed")).toBe("did open");
    expect(await s.control.resume(id, s.ws.id, "claude", "abc-123")).toBe("did terminal");
    expect(seen).toEqual([
      ["agent", { prompt: "fix the footer" }],
      ["open", { root: s.site, files: ["a.ts", "b.ts"] }],
      ["terminal", { cwd: s.site, name: "malves · Claude", command: "claude --resume abc-123" }],
    ]);

    await expect(s.control.openChanges(id, "t-none")).rejects.toThrow(/no recorded changes/);
    await expect(s.control.resume(id, s.ws.id, "antigravity", "x")).rejects.toThrow(
      /can't be reopened/,
    );
    await expect(s.control.agent("gone", "x")).rejects.toThrow(/isn't open any more/);
  });

  it("passes on the IDE's own error, in its words", async () => {
    const s = await setup();
    ide(s.port, {
      folders: [],
      reply: () => ({
        ok: false,
        message: "Antigravity doesn't let other programs start its agent.",
      }),
    });
    await waitFor(() => s.bridge.list().length === 1, "the IDE");
    await expect(s.control.agent(s.bridge.list()[0]?.id ?? "", "x")).rejects.toThrow(
      "Antigravity doesn't let other programs start its agent.",
    );
  });

  it("shows agent questions in the IDE, and an answer given there counts", async () => {
    const s = await setup();
    const taskId = s.core.tasks.create({ workspaceId: s.ws.id, agent: "claude", prompt: "fix it" });
    const window = ide(s.port, { folders: [s.site] });
    await waitFor(() => s.bridge.list().length === 1, "the IDE");
    const answered = s.core.questions.ask({
      taskId,
      kind: "permission",
      text: "Write index.html?",
      choices: [
        { id: "allow", label: "Allow" },
        { id: "skip", label: "Skip" },
      ],
      risk: "high",
      timeoutMs: 60_000,
    });
    await waitFor(() => window.got.some((m) => m.type === "question"), "the question");
    const q = window.got.find((m) => m.type === "question");
    expect(q).toMatchObject({
      agent: "Claude",
      task: "fix it",
      text: "Write index.html?",
      risk: "high",
    });

    window.socket.send(
      JSON.stringify({ type: "answer", question_id: q?.question_id, choice_id: "allow" }),
    );
    expect(await answered).toEqual({ outcome: "answered", choiceId: "allow" });
    await waitFor(() => window.got.some((m) => m.type === "closed"), "the close");
  });
});

describe("resume commands", () => {
  it("builds the CLI command, and refuses any id that could inject into a terminal", () => {
    expect(resumeCommand("claude", "3f2a-9b")).toBe("claude --resume 3f2a-9b");
    expect(resumeCommand("codex-free", "abc")).toBe("codex resume abc");
    expect(resumeCommand("cursor", "c1")).toBe("agent --resume c1");
    expect(resumeCommand("claude", "x; rm -rf ~")).toBeUndefined();
    expect(resumeCommand("claude", "$(whoami)")).toBeUndefined();
    expect(resumeCommand("antigravity", "x")).toBeUndefined();
  });
});
