import { existsSync } from "node:fs";
import path from "node:path";
import { commandId } from "@malves/protocol";
import { startRelay } from "@malves/relay";
import { afterEach, describe, expect, it } from "vitest";
import { connect, pairPhone, sleep, startServed } from "./helpers.js";

const TOKEN = "r".repeat(40);
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function relayed(port = 0) {
  const relay = await startRelay({ host: "127.0.0.1", port, token: TOKEN });
  const s = await startServed({ relay: { url: relay.url, token: TOKEN }, listen: "" });
  cleanups.push(() => s.served.stop());
  return { relay, ...s };
}

describe("topology B: phone ↔ relay ↔ runner", () => {
  it("pairs and runs a task entirely through the relay", async () => {
    const { relay, served, ws, site } = await relayed();
    cleanups.push(() => relay.close());
    expect(served.linkUrl).toBe(`${relay.url}/phone/${served.runner.identity.runnerId}`);
    for (let i = 0; i < 100; i++) {
      try {
        await pairPhone(served);
        break;
      } catch {
        await sleep(30); // the runner is still dialling out
      }
    }
    const phone = await pairPhone(served);
    const link = connect(served, phone);
    cleanups.push(() => link.client.stop());
    await link.welcomed();

    await link.client.send({
      t: "task.create",
      id: commandId(),
      workspace_id: ws.id,
      agent: "demo",
      prompt: "via relay",
    });
    const q = await link.next((e) => e.type === "question.opened");
    if (q.type !== "question.opened") throw new Error();
    await link.client.send({
      t: "answer",
      id: commandId(),
      question_id: q.data.question_id,
      choice_id: "allow",
    });
    await link.next((e) => e.type === "task.updated" && e.data.state === "done");
    expect(existsSync(path.join(site, "malves-demo.txt"))).toBe(true);
  }, 30_000);

  it("the runner reconnects after the relay restarts, and the phone catches up", async () => {
    const first = await relayed();
    const port = Number(new URL(first.relay.url).port);
    let phone: Awaited<ReturnType<typeof pairPhone>> | undefined;
    for (let i = 0; i < 100 && !phone; i++) {
      phone = await pairPhone(first.served).catch(async () => {
        await sleep(30);
        return undefined;
      });
    }
    const link = connect(first.served, phone!, { backoff: { baseMs: 50, maxMs: 200 } });
    cleanups.push(() => link.client.stop());
    await link.welcomed();

    await first.relay.close();
    first.served.runner.workspaces.register("added-while-relay-down", "/tmp/elsewhere");
    const again = await startRelay({ host: "127.0.0.1", port, token: TOKEN });
    cleanups.push(() => again.close());

    const event = await link.next(
      (e) => e.type === "workspace.registered" && e.data.name === "added-while-relay-down",
      20_000,
    );
    expect(event).toBeDefined();
  }, 40_000);
});
