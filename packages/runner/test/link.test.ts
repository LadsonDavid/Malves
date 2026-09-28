import { existsSync } from "node:fs";
import path from "node:path";
import {
  Channel,
  CommandError,
  commandId,
  decodeInvite,
  generateKeyPair,
  LINK_VERSION,
  pair,
  parseFrame,
} from "@malves/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { handleControl } from "../src/control.js";
import type { Served } from "../src/serve.js";
import { connect, pairPhone, sleep, startServed } from "./helpers.js";

const running: Served[] = [];
const clients: Array<{ stop(): void }> = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const s of running.splice(0)) await s.stop();
});

async function setup() {
  const s = await startServed();
  running.push(s.served);
  return s;
}

describe("phone link over a real WebSocket", () => {
  it("pairs, starts a task, answers its question, and sees it finish", async () => {
    const { served, ws, site } = await setup();
    const phone = await pairPhone(served);
    const link = connect(served, phone);
    clients.push(link.client);

    const welcome = await link.welcomed();
    expect(welcome.workspaces).toEqual([{ id: ws.id, name: "site" }]);
    expect(welcome.agents).toContainEqual({ name: "demo", available: true });

    const created = await link.client.send({
      t: "task.create",
      id: commandId(),
      workspace_id: ws.id,
      agent: "demo",
      prompt: "from the phone",
    });
    const taskId = (created.data as { task_id: string }).task_id;

    const opened = await link.next((e) => e.type === "question.opened");
    if (opened.type !== "question.opened") throw new Error();
    const answered = await link.client.send({
      t: "answer",
      id: commandId(),
      question_id: opened.data.question_id,
      choice_id: "allow",
    });
    expect(answered.result).toBe("applied");

    await link.next(
      (e) => e.type === "task.updated" && e.data.task_id === taskId && e.data.state === "done",
    );
    expect(existsSync(path.join(site, "malves-demo.txt"))).toBe(true);
  }, 20_000);

  it("never sends device events to the phone", async () => {
    const { served } = await setup();
    const phone = await pairPhone(served);
    const link = connect(served, phone);
    clients.push(link.client);
    await link.welcomed();
    await sleep(100);
    expect(link.events.some((e) => e.type.startsWith("device."))).toBe(false);
    expect(link.events.some((e) => e.type === "workspace.registered")).toBe(true);
  });

  it("resumes from the last sequence number after a dropout, without duplicates", async () => {
    const { served, ws } = await setup();
    const phone = await pairPhone(served);
    const first = connect(served, phone);
    await first.welcomed();
    await sleep(50);
    const seen = first.client.seq;
    first.client.stop();

    served.runner.workspaces.register("while-away", ws.id === "" ? "/" : "/tmp");
    const second = connect(served, phone, { sinceSeq: seen });
    clients.push(second.client);
    await second.next((e) => e.type === "workspace.registered" && e.data.name === "while-away");
    expect(second.events.every((e) => e.seq > seen)).toBe(true);
  });

  it("applies a re-sent task.create once", async () => {
    const { served, ws } = await setup();
    const link = connect(served, await pairPhone(served));
    clients.push(link.client);
    await link.welcomed();
    const cmd = {
      t: "task.create" as const,
      id: "same-id",
      workspace_id: ws.id,
      agent: "demo",
      prompt: "x",
    };
    const a = await link.client.send(cmd);
    const b = await link.client.send({ ...cmd });
    expect(a.data).toEqual(b.data);
    expect(served.runner.tasks.list()).toHaveLength(1);
  });

  it("reports a rejected command as an error, not a crash", async () => {
    const { served } = await setup();
    const link = connect(served, await pairPhone(served));
    clients.push(link.client);
    await link.welcomed();
    const attempt = link.client.send({
      t: "task.create",
      id: commandId(),
      workspace_id: "ws_not_registered",
      agent: "demo",
      prompt: "x",
    });
    await expect(attempt).rejects.toBeInstanceOf(CommandError);
    // The connection is still usable.
    const status = await link.client.send({ t: "computer.status", id: commandId() });
    expect(status.result).toBe("ok");
  });

  it("pages back through history", async () => {
    const { served } = await setup();
    for (let i = 0; i < 5; i++) served.runner.workspaces.register(`w${i}`, `/tmp/w${i}`);
    const link = connect(served, await pairPhone(served));
    clients.push(link.client);
    await link.welcomed();
    const page = await link.client.send({ t: "history", id: commandId(), limit: 3 });
    const data = page.data as { events: Array<{ seq: number }>; next_before_seq: number | null };
    expect(data.events).toHaveLength(3);
    expect(data.events[0]!.seq).toBeGreaterThan(data.events[2]!.seq);
    const more = await link.client.send({
      t: "history",
      id: commandId(),
      limit: 3,
      before_seq: data.next_before_seq as number,
    });
    const older = (more.data as { events: Array<{ seq: number }> }).events;
    expect(older[0]!.seq).toBeLessThan(data.events[2]!.seq);
  });
});

describe("link security", () => {
  it("refuses a phone that was never paired", async () => {
    const { served } = await setup();
    const statuses: string[] = [];
    const link = connect(served, generateKeyPair(), { onStatus: (s) => statuses.push(s.state) });
    clients.push(link.client);
    await sleep(300);
    expect(link.welcomes).toEqual([]);
  });

  it("a pairing code works once", async () => {
    const { served } = await setup();
    const response = await handleControl(
      served.runner,
      { cmd: "pair" },
      { linkUrl: served.linkUrl },
    );
    const invite = decodeInvite((response as { data: { invite: string } }).data.invite);
    await pair(invite, generateKeyPair(), "first");
    await expect(pair(invite, generateKeyPair(), "second")).rejects.toThrow(/not valid/);
    expect(served.runner.devices.list().map((d) => d.name)).toEqual(["first"]);
  });

  it("revoking a phone closes its connection and keeps it out", async () => {
    const { served } = await setup();
    const phone = await pairPhone(served);
    const statuses: string[] = [];
    const link = connect(served, phone, { onStatus: (s) => statuses.push(s.state) });
    clients.push(link.client);
    await link.welcomed();
    served.runner.devices.revoke(phone.deviceId);
    await sleep(300);
    expect(statuses).toContain("offline");
    expect(link.welcomes).toHaveLength(1);
  });

  it("closes the connection on a replayed hello", async () => {
    const { served } = await setup();
    const phone = await pairPhone(served);
    // Record a genuine hello from one connection…
    const recorded = await rawHello(served, phone);
    // …and replay it into a new one: its challenge is stale, so it must be refused.
    const socket = new WebSocket(served.linkUrl);
    const closed = new Promise<boolean>((resolve) => {
      let welcomed = false;
      socket.onmessage = (m) => {
        const text = String(m.data);
        if (text.includes('"challenge"')) socket.send(recorded);
        else welcomed = true;
      };
      socket.onclose = () => resolve(!welcomed);
    });
    expect(await closed).toBe(true);
  });

  it("rejects garbage without crashing the runner", async () => {
    const { served } = await setup();
    const socket = new WebSocket(served.linkUrl);
    await new Promise<void>((resolve) => {
      socket.onopen = () => socket.send("{not json");
      socket.onclose = () => resolve();
    });
    const phone = await pairPhone(served);
    const link = connect(served, phone);
    clients.push(link.client);
    await link.welcomed();
  });
});

function rawHello(served: Served, phone: { publicKey: Uint8Array; secretKey: Uint8Array }) {
  return new Promise<string>((resolve) => {
    const socket = new WebSocket(served.linkUrl);
    const channel = new Channel(phone.secretKey, served.runner.identity.keyPair.publicKey);
    socket.onmessage = (m) => {
      const text = String(m.data);
      if (text.includes('"challenge"')) {
        const { r } = JSON.parse(text) as { r: string };
        const hello = channel.seal(
          { t: "hello", v: LINK_VERSION, r, since_seq: 0, wish: ["tasks"] },
          phone.publicKey,
        );
        socket.send(hello);
        resolve(hello);
        socket.close();
      } else {
        parseFrame(text);
      }
    };
  });
}
