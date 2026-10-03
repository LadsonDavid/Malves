import { mkdtempSync, realpathSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, type Notifier } from "@malves/core";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpHost } from "../src/adapters/acp/host.js";
import { NtfyPush } from "../src/adapters/push/ntfy.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * Notifications through the ntfy phone app, with malves as the ntfy server.
 * The "phone" here speaks ntfy's subscribe API exactly as the ntfy Android app
 * does (JSON stream or WebSocket), and taps answer buttons with a POST.
 */
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Msg = {
  event: string;
  id: string;
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  sequence_id?: string;
  actions?: Array<{ action: string; label: string; url: string; method: string; clear: boolean }>;
};

async function setup() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-push-")));
  const store = new SqliteStore(path.join(dir, "malves.db"));
  let push: NtfyPush | undefined;
  const notifier: Notifier = { questionOpened: async (q) => push?.questionOpened(q) };
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier,
    host: new AcpHost(),
    agents: new Map(),
    questionTimeoutMs: 60_000,
  });
  push = new NtfyPush(core, { host: "127.0.0.1", port: 0, topic: "secret-topic-abcdefgh" });
  await push.start();
  cleanup.push(() => store.close());
  cleanup.push(() => push?.close());
  const ask = (choices = ["Allow", "Skip"], risk: "low" | "high" = "high") =>
    core.questions.ask({
      taskId: "t1",
      kind: "permission",
      text: "Write index.html?",
      choices: choices.map((label) => ({ id: label.toLowerCase(), label })),
      risk,
      timeoutMs: 60_000,
    });
  return { core, push, ask, base: new URL(push.subscribeUrl).origin };
}

/** Subscribes like the ntfy app's JSON stream; collects every message. */
function stream(url: string) {
  const got: Msg[] = [];
  let status = 0;
  const req = get(url, (res) => {
    status = res.statusCode ?? 0;
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line) got.push(JSON.parse(line) as Msg);
    });
  });
  req.on("error", () => {});
  cleanup.push(() => req.destroy());
  return { got, status: () => status };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tap = (url: string) => fetch(url, { method: "POST" });

describe("notifications through the ntfy app", () => {
  it("a question arrives with answer buttons; one tap answers it and clears the notification", async () => {
    const s = await setup();
    const phone = stream(`${s.push.subscribeUrl}/json?since=all`);
    await waitFor(() => phone.got.some((m) => m.event === "open"), "the subscription");

    const answered = s.ask();
    await waitFor(() => phone.got.some((m) => m.event === "message"), "the notification");
    const note = phone.got.find((m) => m.event === "message");
    expect(note).toMatchObject({
      topic: "secret-topic-abcdefgh",
      title: "An agent asks permission · high risk",
      message: "Write index.html?",
      priority: 5,
    });
    expect(note?.actions?.map((a) => [a.action, a.label, a.method, a.clear])).toEqual([
      ["http", "Allow", "POST", true],
      ["http", "Skip", "POST", true],
    ]);

    const allow = note?.actions?.[0]?.url ?? "";
    const res = await tap(allow);
    expect([res.status, await res.text()]).toEqual([200, "Done."]);
    expect(await answered).toMatchObject({ outcome: "answered", choiceId: "allow" });
    await waitFor(() => phone.got.some((m) => m.event === "message_delete"), "the clear");
    expect(phone.got.find((m) => m.event === "message_delete")?.sequence_id).toBe(note?.id);

    // A button is single use, and every button dies with its question.
    expect((await tap(allow)).status).toBe(410);
    expect((await tap(note?.actions?.[1]?.url ?? "")).status).toBe(410);
  });

  it("only the secret topic works; the app's auth check and catch-up poll are answered", async () => {
    const s = await setup();
    void s.ask(["Allow", "Skip"], "low");
    expect((await fetch(`${s.base}/wrong-topic-abcdefghi/json`)).status).toBe(404);
    expect((await fetch(`${s.base}/wrong-topic-abcdefghi/auth`)).status).toBe(404);
    expect(await (await fetch(`${s.push.subscribeUrl}/auth`)).json()).toEqual({ success: true });

    const poll = await (await fetch(`${s.push.subscribeUrl}/json?poll=1&since=all`)).text();
    const missed = poll
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Msg);
    expect(missed.map((m) => [m.event, m.priority])).toEqual([["message", 4]]);
    // Several topics on one server, as the app asks for them, still works.
    const both = stream(`${s.base}/other,secret-topic-abcdefgh/json`);
    await waitFor(() => both.got.some((m) => m.event === "message"), "catch-up on connect");
  });

  it("works over WebSocket too, and shows at most three buttons", async () => {
    const s = await setup();
    const ws = new WebSocket(`${s.push.subscribeUrl.replace("http", "ws")}/ws?since=all`);
    cleanup.push(() => ws.terminate());
    const got: Msg[] = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data)) as Msg));
    await waitFor(() => got.some((m) => m.event === "open"), "the socket");

    void s.ask(["Yes", "No", "Later", "Never"]);
    await waitFor(() => got.some((m) => m.event === "message"), "the notification");
    const note = got.find((m) => m.event === "message");
    expect(note?.actions?.map((a) => a.label)).toEqual(["Yes", "No", "Later"]);
    expect(note?.message).toContain("More choices in the malves app.");
  });

  it("a new topic (a phone was revoked) cuts off subscribers and kills every button sent", async () => {
    const s = await setup();
    const phone = stream(`${s.push.subscribeUrl}/json`);
    await waitFor(() => phone.got.some((m) => m.event === "open"), "the subscription");
    const answered = s.ask();
    await waitFor(() => phone.got.some((m) => m.event === "message"), "the notification");
    const allow = phone.got.find((m) => m.event === "message")?.actions?.[0]?.url ?? "";

    s.push.renew("brand-new-topic-12345678");
    expect((await tap(allow)).status).toBe(410);
    expect((await fetch(`${s.base}/secret-topic-abcdefgh/json?poll=1`)).status).toBe(404);
    expect(s.push.subscribeLink).toBe(
      `ntfy://${new URL(s.base).host}/brand-new-topic-12345678?secure=false&display=malves`,
    );
    // The question itself is untouched: it can still be answered in the app.
    expect(s.core.questions.pending()).toHaveLength(1);
    void answered;
  });
});
