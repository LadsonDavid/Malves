import { command } from "@malves/core";
import { afterEach, describe, expect, it } from "vitest";
import { GateBroker } from "../src/adapters/browser_gate/broker.js";
import type { Served } from "../src/serve.js";
import { sleep, startServed } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function waitingTask(served: Served, wsId: string) {
  const id = served.runner.tasks.create({
    workspaceId: wsId,
    agent: "demo",
    prompt: "x",
    browser: true,
  });
  for (let i = 0; i < 200 && served.runner.tasks.get(id)?.state !== "waiting"; i++) await sleep(20);
  return id;
}

function gateEnv(broker: GateBroker, taskId: string, root: string) {
  const extras = broker.extrasFor({
    taskId,
    agent: "demo",
    command: command("x"),
    workspaceRoot: root,
    prompt: "x",
    browser: true,
  });
  const server = extras.mcpServers?.[0] as { env: Array<{ name: string; value: string }> };
  const get = (n: string) => server.env.find((e) => e.name === n)?.value as string;
  return { url: get("MALVES_GATE_URL"), token: get("MALVES_GATE_TOKEN") };
}

const ask = (url: string, token: string, text: string) =>
  fetch(`${url}/ask`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, risk: "high" }),
  });

describe("gate broker", () => {
  it("turns a gate request into a browser_action question for that task", async () => {
    const { served, ws, site } = await startServed();
    cleanups.push(() => served.stop());
    const broker = new GateBroker({ core: () => served.runner });
    await broker.start();
    cleanups.push(() => broker.close());

    const taskId = await waitingTask(served, ws.id);
    const { url, token } = gateEnv(broker, taskId, site);
    const pending = ask(url, token, "Click Pay?");
    for (let i = 0; i < 100 && served.runner.questions.pending().length < 2; i++) await sleep(20);
    const q = served.runner.questions.pending().find((x) => x.kind === "browser_action");
    expect(q).toMatchObject({ task_id: taskId, text: "Click Pay?", risk: "high" });
    served.runner.questions.answer({
      questionId: q!.question_id,
      choiceId: "deny",
      commandId: "c",
    });
    expect(await (await pending).json()).toEqual({ choice: "deny" });
  }, 20_000);

  it("rejects a wrong token, and a token after its task ended", async () => {
    const { served, ws, site } = await startServed();
    cleanups.push(() => served.stop());
    const broker = new GateBroker({ core: () => served.runner });
    await broker.start();
    cleanups.push(() => broker.close());

    const taskId = await waitingTask(served, ws.id);
    const { url, token } = gateEnv(broker, taskId, site);
    expect((await ask(url, "not-the-token", "x")).status).toBe(401);

    await served.runner.tasks.stop(taskId);
    expect((await ask(url, token, "x")).status).toBe(401);
  }, 20_000);

  it("answers null once the task is stopped while the gate waits", async () => {
    const { served, ws, site } = await startServed();
    cleanups.push(() => served.stop());
    const broker = new GateBroker({ core: () => served.runner });
    await broker.start();
    cleanups.push(() => broker.close());

    const taskId = await waitingTask(served, ws.id);
    const { url, token } = gateEnv(broker, taskId, site);
    const pending = ask(url, token, "Submit?");
    for (let i = 0; i < 100 && served.runner.questions.pending().length < 2; i++) await sleep(20);
    await served.runner.tasks.stop(taskId);
    expect(await (await pending).json()).toEqual({ choice: null });
  }, 20_000);
});
