import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { command } from "@malves/core";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetGuard, type GuardConfig } from "../src/adapters/budget_proxy/guard.js";
import type { Served } from "../src/serve.js";
import { sleep, startServed } from "./helpers.js";

/** A fake OpenAI-compatible gateway whose behaviour each test sets. */
function fakeGateway(name: string) {
  const calls: Array<{ model: string; auth: string | undefined; stream: boolean }> = [];
  let behaviour: { status?: number; answer?: string } = {};
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model: string; stream?: boolean };
      calls.push({
        model: body.model,
        auth: req.headers.authorization,
        stream: body.stream === true,
      });
      if (behaviour.status) {
        return res.writeHead(behaviour.status, { "content-type": "application/json" }).end("{}");
      }
      const model = behaviour.answer ?? body.model;
      const usage = { prompt_tokens: 12, completion_tokens: 7 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ model, choices: [{ delta: { content: `hi from ${name}` } }] })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ model, choices: [], usage })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ model, choices: [{ message: { content: `hi from ${name}` } }], usage }),
      );
    });
  });
  return new Promise<{
    url: string;
    calls: typeof calls;
    set: (b: typeof behaviour) => void;
    close(): void;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        calls,
        set: (b) => {
          behaviour = b;
        },
        close: () => server.close(),
      });
    });
  });
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(configure: (free: string, own: string) => GuardConfig, floor: string[] = []) {
  const free = await fakeGateway("free");
  const own = await fakeGateway("own");
  cleanups.push(
    () => free.close(),
    () => own.close(),
  );
  const { served, ws, site } = await startServed({}, { budget: { floor } });
  cleanups.push(() => served.stop());
  const guard = new BudgetGuard(() => served.runner, configure(free.url, own.url));
  await guard.start();
  cleanups.push(() => guard.close());

  const taskId = served.runner.tasks.create({ workspaceId: ws.id, agent: "demo", prompt: "x" });
  for (let i = 0; i < 200 && served.runner.tasks.get(taskId)?.state !== "waiting"; i++)
    await sleep(20);
  const env = guard.extrasFor(
    {
      taskId,
      agent: "demo",
      command: command("x"),
      workspaceRoot: site,
      prompt: "x",
      browser: false,
    },
    "openai",
  ).env as Record<string, string>;
  const chat = (body: Record<string, unknown>) =>
    fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
    });
  return { served, free, own, taskId, env, chat };
}

const budgetEvents = (served: Served) =>
  served.runner.log.since(0).flatMap((e) => (e.type === "budget.updated" ? [e.data] : []));

async function answerBudgetQuestion(served: Served, choiceId: string) {
  for (let i = 0; i < 200; i++) {
    const q = served.runner.questions.pending().find((x) => x.kind === "budget_floor");
    if (q) {
      served.runner.questions.answer({
        questionId: q.question_id,
        choiceId,
        commandId: `c-${choiceId}`,
      });
      return q;
    }
    await sleep(20);
  }
  throw new Error("no budget question");
}

describe("budget guard", () => {
  it("records which model answered and the tokens used", async () => {
    const { served, chat } = await setup((free) => ({ free: { url: free, key: "free-key" } }));
    const res = await chat({ model: "qwen3-coder" });
    expect(res.status).toBe(200);
    expect(budgetEvents(served)).toEqual([
      expect.objectContaining({
        model: "qwen3-coder",
        via: "free",
        input_tokens: 12,
        output_tokens: 7,
      }),
    ]);
  }, 20_000);

  it("never passes on a switched model silently: it asks, and 'allow' releases the held answer", async () => {
    const { served, free, chat } = await setup((f) => ({ free: { url: f } }));
    free.set({ answer: "llama-3.1-8b" });
    const pending = chat({ model: "qwen3-coder" });
    const q = await answerBudgetQuestion(served, "allow");
    expect(q.text).toContain("You asked for qwen3-coder, but llama-3.1-8b answered.");
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe("llama-3.1-8b");
    expect(budgetEvents(served).at(-1)).toMatchObject({
      model: "llama-3.1-8b",
      requested_model: "qwen3-coder",
    });
  }, 20_000);

  it("offers the user's own key when the free models run out, and uses it from then on", async () => {
    const { served, free, own, chat } = await setup((f, o) => ({
      free: { url: f },
      own: { url: o, key: "sk-own" },
    }));
    free.set({ status: 429 });
    const pending = chat({ model: "gpt-5-mini" });
    const q = await answerBudgetQuestion(served, "own_key");
    expect(q.choices.map((c) => c.id)).toEqual(["own_key", "pause"]);
    expect((await pending).status).toBe(200);
    expect(own.calls.at(-1)?.auth).toBe("Bearer sk-own");
    await chat({ model: "gpt-5-mini" });
    expect(own.calls).toHaveLength(2);
    expect(budgetEvents(served).map((e) => e.via)).toEqual(["own_key", "own_key"]);
  }, 20_000);

  it("'pause' stops the task and the agent gets an error, not an answer", async () => {
    const { served, free, taskId, chat } = await setup((f) => ({ free: { url: f } }));
    free.set({ status: 429 });
    const pending = chat({ model: "x" });
    await answerBudgetQuestion(served, "pause");
    expect((await pending).status).toBe(503);
    expect(served.runner.tasks.get(taskId)).toMatchObject({ state: "stopped" });
    expect(served.runner.tasks.get(taskId)?.reason).toMatch(/^Paused:/);
  }, 20_000);

  it("holds a stream until it knows the model, and checks the floor first", async () => {
    const { served, free, chat } = await setup((f) => ({ free: { url: f } }), ["claude-*"]);
    free.set({ answer: "llama-3.1-8b" });
    const pending = chat({ model: "auto", stream: true });
    const q = await answerBudgetQuestion(served, "allow");
    expect(q.text).toContain("below your quality floor");
    const res = await pending;
    const text = await res.text();
    expect(text).toContain("hi from free");
    expect(free.calls.every((c) => c.stream)).toBe(true);
    expect(budgetEvents(served).at(-1)).toMatchObject({
      model: "llama-3.1-8b",
      input_tokens: 12,
      output_tokens: 7,
    });
  }, 20_000);

  it("rejects unknown tokens and tokens for ended tasks", async () => {
    const { served, env, taskId } = await setup((f) => ({ free: { url: f } }));
    const bad = await fetch(`${env.OPENAI_BASE_URL?.replace(/\/t\/[^/]+/, "/t/nope")}/models`);
    expect(bad.status).toBe(401);
    await served.runner.tasks.stop(taskId);
    const ended = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    expect(ended.status).toBe(401);
  }, 20_000);
});
