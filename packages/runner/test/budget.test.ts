import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentHost,
  type AgentSession,
  command,
  createCore,
  type Notifier,
} from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetGuard, tokensIn } from "../src/adapters/budget/guard.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * The budget guard between a metered agent and freellmapi. freellmapi is played
 * by a local HTTP server that answers in Anthropic's format and says which model
 * served each call in `X-Routed-Via`, as the real one does.
 */
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Answer = {
  status?: number;
  model: string;
  stream?: boolean;
  headers?: Record<string, string>;
};

async function freellmapi(answers: Answer[]) {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    req.resume();
    const a = answers[Math.min(seen.length - 1, answers.length - 1)] as Answer;
    const headers = { "x-routed-via": encodeURIComponent(a.model), ...a.headers };
    if (a.status && a.status !== 200) {
      res.writeHead(a.status, { ...headers, "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "quota_exceeded" } }));
    }
    if (a.stream) {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}\n\n`,
      );
      res.write(
        `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n`,
      );
      return res.end(
        `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n`,
      );
    }
    res.writeHead(200, { ...headers, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** A core with one task that stays running until the test ends it. */
async function setup(upstream: string, allow: string[] = []) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-budget-")));
  const store = new SqliteStore(path.join(dir, "malves.db"));
  let end: (value: "completed") => void = () => {};
  const host: AgentHost = {
    start: (): AgentSession => ({
      finished: new Promise((resolve) => {
        end = resolve;
      }),
      cancel: async () => end("completed"),
    }),
  };
  const noPush: Notifier = { questionOpened: async () => {} };
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier: noPush,
    host,
    agents: new Map([["claude-free", command("x")]]),
    questionTimeoutMs: 10_000,
  });
  const ws = core.workspaces.register("site", dir);
  const taskId = core.tasks.create({ workspaceId: ws.id, agent: "claude-free", prompt: "fix it" });
  const guard = new BudgetGuard(core, { upstream, key: "real-freellmapi-key", allow });
  await guard.start();
  cleanup.push(() => store.close());
  cleanup.push(() => core.tasks.stopAll());
  cleanup.push(() => guard.close());
  const events: LoggedEvent[] = [];
  core.log.subscribe((e) => events.push(e));
  const base = guard.urlFor(taskId);
  /** What Claude Code sends: its placeholder key, to <base>/v1/messages. */
  const call = () =>
    fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "malves-budget-guard",
        authorization: "Bearer malves-budget-guard",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  return { core, taskId, events, call, base, finish: () => end("completed") };
}

const ofType = <T extends LoggedEvent["type"]>(events: LoggedEvent[], type: T) =>
  events.filter((e): e is Extract<LoggedEvent, { type: T }> => e.type === type);

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("budget guard", () => {
  it("passes calls through with the real key, logs the model and every switch, and the task's usage at the end", async () => {
    const api = await freellmapi([
      { model: "google/gemini-2.5-pro" },
      { model: "google/gemini-2.5-pro", stream: true },
      { model: "groq/llama-3.3-70b" },
    ]);
    const s = await setup(api.url);

    const first = await s.call();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ content: [{ text: "ok" }] });
    expect(await (await s.call()).text()).toContain("message_delta");
    await s.call();

    // The agent's placeholder never reaches freellmapi; the real key does.
    expect(api.seen[0]?.headers.authorization).toBe("Bearer real-freellmapi-key");
    expect(api.seen[0]?.headers["x-api-key"]).toBeUndefined();
    expect(api.seen[0]?.url).toBe("/v1/messages");

    expect(ofType(s.events, "task.model").map((e) => e.data.model)).toEqual([
      "google/gemini-2.5-pro",
      "groq/llama-3.3-70b",
    ]);
    s.finish();
    await waitFor(() => ofType(s.events, "task.usage").length > 0, "the usage");
    expect(ofType(s.events, "task.usage")[0]?.data).toEqual({
      task_id: s.taskId,
      calls: 3,
      input_tokens: 10 + 100 + 10,
      output_tokens: 5 + 42 + 5,
    });
    // A finished task's URL stops working.
    expect((await s.call()).status).toBe(403);
  });

  it("R8: a model below the floor is held back and the user is asked; 'Use it' lets it through", async () => {
    const api = await freellmapi([{ model: "groq/llama-3.1-8b" }]);
    const s = await setup(api.url, ["gemini-2.5-pro"]);
    const pending = s.call();
    await waitFor(() => s.core.questions.pending().length > 0, "the question");
    const q = s.core.questions.pending()[0];
    expect(q).toMatchObject({ kind: "budget_floor", task_id: s.taskId });
    expect(q?.text).toContain("groq/llama-3.1-8b");
    expect(ofType(s.events, "task.model")).toEqual([]); // nothing used yet

    s.core.questions.answer({
      questionId: q?.question_id ?? "",
      choiceId: "allow",
      commandId: "c1",
    });
    expect((await pending).status).toBe(200);
    expect(ofType(s.events, "task.model").map((e) => e.data.model)).toEqual(["groq/llama-3.1-8b"]);
    // Asked once per model per task.
    expect((await s.call()).status).toBe(200);
    expect(s.core.questions.pending()).toEqual([]);
  });

  it("R8: 'Stop the task' stops it, and the weak model's answer never reaches the agent", async () => {
    const api = await freellmapi([{ model: "groq/llama-3.1-8b" }]);
    const s = await setup(api.url, ["gemini"]);
    const pending = s.call();
    await waitFor(() => s.core.questions.pending().length > 0, "the question");
    const q = s.core.questions.pending()[0];
    s.core.questions.answer({
      questionId: q?.question_id ?? "",
      choiceId: "stop",
      commandId: "c1",
    });
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("ok");
    await waitFor(() => s.core.tasks.get(s.taskId)?.state === "stopped", "the stop");
    expect(s.core.tasks.get(s.taskId)?.reason).toContain("below your quality floor");
  });

  it("when the free quota is used up, the task stops with a plain reason", async () => {
    const api = await freellmapi([{ status: 429, model: "", headers: { "retry-after": "3600" } }]);
    const s = await setup(api.url);
    expect((await s.call()).status).toBe(429);
    await waitFor(() => s.core.tasks.get(s.taskId)?.state === "stopped", "the stop");
    expect(s.core.tasks.get(s.taskId)?.reason).toBe(
      "The free models are used up for now (try again in 3600 s). Add more keys in freellmapi, or run this with Claude on your subscription.",
    );
  });

  it("refuses URLs that aren't a task's", async () => {
    const api = await freellmapi([{ model: "google/gemini-2.5-pro" }]);
    const s = await setup(api.url);
    const origin = new URL(s.base).origin;
    expect((await fetch(`${origin}/t/not-a-token/v1/messages`, { method: "POST" })).status).toBe(
      403,
    );
    expect((await fetch(`${origin}/v1/messages`, { method: "POST" })).status).toBe(403);
    expect(api.seen).toEqual([]);
  });

  it("counts tokens in OpenAI's format too", () => {
    expect(
      tokensIn(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } }), true),
    ).toEqual([7, 3]);
    expect(tokensIn("data: [DONE]\n", false)).toEqual([0, 0]);
  });
});
