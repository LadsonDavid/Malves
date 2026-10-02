import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command, createCore, type Notifier } from "@malves/core";
import {
  type AgentInfo,
  CLOSE,
  generateKeyPair,
  type KeyPair,
  LINK_VERSION,
  LinkClient,
  type LinkStatus,
  type LoggedEvent,
  randomToken,
  seal,
  type Welcome,
} from "@malves/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AcpHost } from "../src/adapters/acp/host.js";
import { LinkServer } from "../src/adapters/link/server.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * The phone link end to end: the real LinkClient (the code the app runs)
 * against the real LinkServer, over a real WebSocket, driving the real demo
 * agent over ACP. Nothing on the wire is mocked.
 */
const demoAgent = fileURLToPath(new URL("../src/demo-agent.ts", import.meta.url));
const noPush: Notifier = { questionOpened: async () => {} };
const cleanup: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Stands in for AgentStatus: a list of agents whose states the test controls. */
function fakeAgents(initial: AgentInfo[]) {
  let list = initial;
  const listeners = new Set<(agents: AgentInfo[]) => void>();
  return {
    list: () => list,
    subscribe(listener: (agents: AgentInfo[]) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** "Checking again" finds every agent ready — as if the user just signed in. */
    async checkAll() {
      list = list.map(({ hint: _hint, ...a }) => ({ ...a, state: "ready" as const }));
      for (const listener of listeners) listener(list);
    },
  };
}

async function runner(agentList: AgentInfo[] = [{ name: "demo", label: "Demo", state: "ready" }]) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-link-")));
  const site = path.join(dir, "site");
  mkdirSync(site);
  const store = new SqliteStore(path.join(dir, "malves.db"));
  const host = new AcpHost();
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier: noPush,
    host,
    agents: new Map([["demo", command(process.execPath, [demoAgent])]]),
    questionTimeoutMs: 10_000,
  });
  const ws = core.workspaces.register("site", site);
  const keys = generateKeyPair();
  const server = new LinkServer(core, {
    host: "127.0.0.1",
    port: 0,
    keys,
    computer: "test-pc",
    agents: fakeAgents(agentList),
  });
  await server.start();
  // Same order as `malves serve` shutting down: stop tasks, then close the log.
  cleanup.push(async () => {
    await core.tasks.stopAll();
    host.killAll();
    store.close();
  });
  cleanup.push(() => server.close());
  return { core, server, keys, ws, site };
}

type Phone = {
  client: LinkClient;
  keys: KeyPair;
  events: LoggedEvent[];
  statuses: LinkStatus[];
  /** Every live agent update received. */
  agentUpdates: AgentInfo[][];
  welcome?: Welcome;
};

function phone(
  r: Awaited<ReturnType<typeof runner>>,
  options: {
    keys?: KeyPair;
    pair?: { code: string; name: string };
    sinceSeq?: number;
    wish?: string[];
  } = {},
): Phone {
  const keys = options.keys ?? generateKeyPair();
  const p: Phone = {
    keys,
    events: [],
    statuses: [],
    agentUpdates: [],
    client: undefined as never,
  };
  p.client = new LinkClient({
    url: r.server.url,
    runnerKey: r.keys.publicKey,
    keys,
    ...(options.pair ? { pair: options.pair } : {}),
    ...(options.sinceSeq !== undefined ? { sinceSeq: options.sinceSeq } : {}),
    ...(options.wish ? { wish: options.wish } : {}),
    onWelcome: (w) => {
      p.welcome = w;
    },
    onEvent: (e) => p.events.push(e),
    onStatus: (s) => p.statuses.push(s),
    onAgents: (agents) => p.agentUpdates.push(agents),
    maxBackoffMs: 200,
  });
  p.client.connect();
  cleanup.push(() => p.client.close());
  return p;
}

async function waitFor(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isOnline = (p: Phone) => () => p.statuses.at(-1) === "online";
const isRejected = (p: Phone) => () => p.statuses.at(-1) === "rejected";

async function pairedPhone(r: Awaited<ReturnType<typeof runner>>, extra = {}) {
  const { code } = r.server.offerPairing();
  const p = phone(r, { pair: { code, name: "Pixel 8" }, ...extra });
  await waitFor(isOnline(p), "pairing");
  return p;
}

describe("phone link, end to end", () => {
  it("pairs with the QR code, then reconnects without it", async () => {
    const r = await runner();
    const first = await pairedPhone(r);
    expect(first.welcome).toMatchObject({
      computer: "test-pc",
      workspaces: [{ id: r.ws.id, name: "site" }],
      agents: [{ name: "demo", label: "Demo", state: "ready" }],
    });
    expect(r.core.devices.list()).toEqual([
      expect.objectContaining({ name: "Pixel 8", publicKey: first.keys.publicKey }),
    ]);
    first.client.close();

    const again = phone(r, { keys: first.keys });
    await waitFor(isOnline(again), "reconnecting as a paired phone");
    expect(again.welcome?.device_id).toBe(first.welcome?.device_id);
  });

  it("the phone sees which agents need sign-in, and 'check again' updates it live", async () => {
    const r = await runner([
      { name: "claude", label: "Claude", state: "needs_sign_in", hint: "Run `claude`, /login." },
      { name: "demo", label: "Demo", state: "ready" },
    ]);
    const p = await pairedPhone(r);
    expect(p.welcome?.agents.map((a) => [a.name, a.state])).toEqual([
      ["claude", "needs_sign_in"],
      ["demo", "ready"],
    ]);
    expect(p.welcome?.agents[0]?.hint).toBe("Run `claude`, /login.");

    expect(await p.client.checkAgents()).toMatchObject({ ok: true });
    await waitFor(() => p.agentUpdates.length > 0, "the live agent update");
    expect(p.agentUpdates.at(-1)?.map((a) => [a.name, a.state, a.hint])).toEqual([
      ["claude", "ready", undefined],
      ["demo", "ready", undefined],
    ]);
  });

  it("refuses a wrong pairing code, and a code that was already used", async () => {
    const r = await runner();
    const { code } = r.server.offerPairing();
    const wrong = phone(r, { pair: { code: randomToken(24), name: "x" } });
    await waitFor(isRejected(wrong), "rejecting a wrong code");

    const ok = phone(r, { pair: { code, name: "mine" } });
    await waitFor(isOnline(ok), "pairing with the right code");
    const reused = phone(r, { pair: { code, name: "thief" } });
    await waitFor(isRejected(reused), "rejecting a reused code");
    expect(r.core.devices.list().map((d) => d.name)).toEqual(["mine"]);
  });

  it("refuses a phone that was never paired", async () => {
    const r = await runner();
    const stranger = phone(r);
    await waitFor(isRejected(stranger), "rejecting an unpaired phone");
  });

  it("the phone starts a task, gets the agent's question, answers it, and the agent acts", async () => {
    const r = await runner();
    const p = await pairedPhone(r);

    const created = await p.client.createTask({
      workspaceId: r.ws.id,
      agent: "demo",
      prompt: "make the file",
    });
    expect(created).toMatchObject({ ok: true });
    const taskId = created.result ?? "";

    await waitFor(() => p.events.some((e) => e.type === "question.opened"), "the question");
    const question = p.events.find((e) => e.type === "question.opened");
    if (question?.type !== "question.opened") throw new Error("no question");
    expect(question.data.task_id).toBe(taskId);
    expect(existsSync(path.join(r.site, "malves-demo.txt"))).toBe(false);

    const answered = await p.client.answer({
      questionId: question.data.question_id,
      choiceId: "allow",
    });
    expect(answered).toMatchObject({ ok: true, result: "applied" });

    await waitFor(
      () => p.events.some((e) => e.type === "task.updated" && e.data.state === "done"),
      "the task to finish",
    );
    expect(readFileSync(path.join(r.site, "malves-demo.txt"), "utf8")).toContain("make the file");
  }, 20_000);

  it("resumes from the last event it saw, and never sees device events", async () => {
    const r = await runner();
    const p = await pairedPhone(r);
    await waitFor(() => p.events.length > 0, "the backlog");
    const seen = p.client.lastSeq;
    p.client.close();

    r.core.workspaces.register("later", path.join(r.site, ".."));
    const resumed = phone(r, { keys: p.keys, sinceSeq: seen });
    await waitFor(() => resumed.events.length > 0, "events after the dropout");

    expect(resumed.events.every((e) => e.seq > seen)).toBe(true);
    expect(resumed.events.map((e) => e.type)).toEqual(["workspace.registered"]);
    expect([...p.events, ...resumed.events].some((e) => e.type.startsWith("device."))).toBe(false);
  });

  it("Wish List: the phone gets only the event types it asked for", async () => {
    const r = await runner();
    const p = await pairedPhone(r, { wish: ["task.created"] });
    await p.client.createTask({ workspaceId: r.ws.id, agent: "demo", prompt: "x" });
    await waitFor(() => p.events.length > 0, "a task event");
    expect(new Set(p.events.map((e) => e.type))).toEqual(new Set(["task.created"]));
  });

  it("a command sent twice is run once", async () => {
    const r = await runner();
    const twice = {
      type: "task.create",
      command_id: "same-id",
      workspace_id: r.ws.id,
      agent: "demo",
      prompt: "once",
    } as const;
    const [a, b] = await Promise.all([r.server.execute(twice), r.server.execute(twice)]);
    expect(a).toEqual(b);
    expect(r.core.tasks.list()).toHaveLength(1);
  });

  it("refuses commands it can't run, without dropping the phone", async () => {
    const r = await runner();
    const p = await pairedPhone(r);
    const bad = await p.client.createTask({ workspaceId: "ws_nope", agent: "demo", prompt: "x" });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/workspace/i) });
    expect(p.statuses.at(-1)).toBe("online");
  });

  it("revoking a phone on the computer disconnects it immediately, for good", async () => {
    const r = await runner();
    const p = await pairedPhone(r);
    const id = p.welcome?.device_id ?? "";
    r.core.devices.revoke(id);
    await waitFor(isRejected(p), "the revoked phone to be dropped");

    const back = phone(r, { keys: p.keys });
    await waitFor(isRejected(back), "the revoked phone to be refused on reconnect");
  });

  it("refuses a hello made for a different connection's challenge (replay)", async () => {
    const r = await runner();
    const p = await pairedPhone(r);
    p.client.close();

    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(r.server.url);
      ws.onmessage = () => {
        const stale = {
          type: "hello",
          v: LINK_VERSION,
          challenge: randomToken(24),
          since_seq: 0,
        };
        ws.send(
          JSON.stringify({
            device: p.keys.publicKey,
            ...seal(stale, r.keys.publicKey, p.keys.secretKey),
          }),
        );
      };
      ws.onclose = (event) => resolve(event.code);
    });
    expect(closed).toBe(CLOSE.BAD_MESSAGE);
  });

  it("drops a connection that sends garbage after the handshake", async () => {
    const r = await runner();
    const p = await pairedPhone(r);
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(r.server.url);
      let step = 0;
      ws.onmessage = (event) => {
        step += 1;
        if (step === 1) {
          const { challenge } = JSON.parse(String(event.data)) as { challenge: string };
          const hello = { type: "hello", v: LINK_VERSION, challenge, since_seq: 0 };
          ws.send(
            JSON.stringify({
              device: p.keys.publicKey,
              ...seal(hello, r.keys.publicKey, p.keys.secretKey),
            }),
          );
        } else if (step === 2) {
          ws.send(JSON.stringify({ n: "AAAA", c: "not a sealed command" }));
        }
      };
      ws.onclose = (event) => resolve(event.code);
    });
    expect(closed).toBe(CLOSE.BAD_MESSAGE);
  });
});
