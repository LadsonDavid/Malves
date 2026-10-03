import { STOPPED_WAITING } from "@malves/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { flush, setup, TIMEOUT } from "../../core/test/fakes.js";
import { type Browser, BrowserBridge } from "../src/adapters/browser/bridge.js";
import { BrowserTools, siteOf } from "../src/adapters/browser/tools.js";

const cleanup: Array<() => unknown> = [];

/** The SDK's client transport trips our exactOptionalPropertyTypes; it is the right type. */
const httpTransport = (url: string) =>
  new StreamableHTTPClientTransport(new URL(url)) as unknown as Parameters<Client["connect"]>[0];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Stands in for Chrome: one shop page, records every operation. */
class FakeChrome implements Browser {
  connected = true;
  readonly calls: Array<[string, Record<string, unknown> | undefined]> = [];
  url = "https://shop.example/cart";

  async call(op: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) throw new Error("Chrome isn't connected to malves.");
    this.calls.push([op, args]);
    switch (op) {
      case "info":
        return { url: this.url, title: "Your cart" };
      case "snapshot":
        return {
          url: this.url,
          title: "Your cart",
          text: "1 item · £20",
          elements: [
            { ref: "e1", role: "button", label: "Place order" },
            { ref: "e2", role: "password field", label: "Password", sensitive: true },
          ],
        };
      case "type":
        return args?.ref === "e2" ? { refused: "Refused: never types into password fields." } : {};
      default:
        return {};
    }
  }

  /** Operations other than reading where the tab is. */
  get actions(): string[] {
    return this.calls.map(([op]) => op).filter((op) => op !== "info");
  }
}

async function harness() {
  const core = setup();
  const ws = core.workspaces.register("site", process.cwd());
  // An agent that stays busy, so its task is running while the tools are used.
  core.host.script = () => new Promise(() => {});
  const taskId = core.tasks.create({ workspaceId: ws.id, agent: "demo", prompt: "buy it" });
  await flush();

  const chrome = new FakeChrome();
  const tools = new BrowserTools(core, chrome);
  await tools.start();
  cleanup.push(() => tools.close());

  const [server] = tools.serversFor(taskId);
  if (!server || !("url" in server)) throw new Error("expected an http tool server");
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(httpTransport(server.url));
  cleanup.push(() => client.close());

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>;
  const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]?.text ?? "";

  /** Waits for the phone's question, then answers it. */
  const answer = async (choiceId: "allow" | "deny") => {
    for (let i = 0; i < 200 && core.questions.pending().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const q = core.questions.pending()[0];
    if (!q) throw new Error("no question reached the phone");
    core.questions.answer({ questionId: q.question_id, choiceId, commandId: `c-${q.question_id}` });
    return q;
  };

  return { core, chrome, tools, taskId, url: server.url, call, textOf, answer };
}

describe("browser tools, through the phone gate", () => {
  it("offers the eight browser tools to the agent", async () => {
    const h = await harness();
    const client = new Client({ name: "lister", version: "1.0.0" });
    await client.connect(httpTransport(h.url));
    cleanup.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "browser_back",
      "browser_click",
      "browser_navigate",
      "browser_press",
      "browser_scroll",
      "browser_select",
      "browser_snapshot",
      "browser_type",
    ]);
  });

  it("asks before reading a site the task hasn't used yet — once per site", async () => {
    const h = await harness();
    const pending = h.call("browser_snapshot");
    const q = await h.answer("allow");
    expect(q.kind).toBe("browser_action");
    expect(q.text).toContain("Let the agent read https://shop.example?");
    const read = h.textOf(await pending);
    expect(read).toContain('[e1] button "Place order"');
    expect(read).toContain("password/card field: malves never types here");

    // Same site again: no second question.
    const again = await h.call("browser_snapshot");
    expect(h.textOf(again)).toContain("Your cart");
    expect(h.core.questions.pending()).toEqual([]);
  });

  it("reads nothing if the user says no", async () => {
    const h = await harness();
    const pending = h.call("browser_snapshot");
    await h.answer("deny");
    expect(h.textOf(await pending)).toMatch(/didn't allow/);
    expect(h.chrome.actions).toEqual([]);
  });

  it("asks before every click, naming the button, and clicks only after Allow", async () => {
    const h = await harness();
    const read = h.call("browser_snapshot");
    await h.answer("allow");
    await read;

    const declined = h.call("browser_click", { ref: "e1" });
    const q1 = await h.answer("deny");
    expect(q1.text).toBe('Click the button "Place order" on https://shop.example?');
    expect(q1.risk).toBe("high");
    expect(h.textOf(await declined)).toMatch(/didn't allow/);
    expect(h.chrome.actions).not.toContain("click");

    const allowed = h.call("browser_click", { ref: "e1" });
    await h.answer("allow");
    await allowed;
    expect(h.chrome.calls).toContainEqual(["click", { ref: "e1" }]);
  });

  it("R3: an unanswered browser question stops the task, and nothing is clicked", async () => {
    const h = await harness();
    const read = h.call("browser_snapshot");
    await h.answer("allow");
    await read;

    const pending = h.call("browser_click", { ref: "e1" });
    for (let i = 0; i < 200 && h.core.questions.pending().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    h.core.clock.advance(TIMEOUT);
    expect(h.textOf(await pending)).toMatch(/didn't allow/);
    expect(h.core.tasks.get(h.taskId)).toMatchObject({ state: "stopped", reason: STOPPED_WAITING });
    expect(h.chrome.actions).not.toContain("click");
  });

  it("passes on Chrome's refusal to type into a password field", async () => {
    const h = await harness();
    const read = h.call("browser_snapshot");
    await h.answer("allow");
    await read;
    const typing = h.call("browser_type", { ref: "e2", text: "hunter2" });
    await h.answer("allow");
    expect(h.textOf(await typing)).toMatch(/Refused/);
  });

  it("won't open anything but http and https, and doesn't bother the phone about it", async () => {
    const h = await harness();
    const result = await h.call("browser_navigate", { url: "file:///etc/passwd" });
    expect(h.textOf(result)).toMatch(/Only http and https/);
    expect(h.core.questions.pending()).toEqual([]);
    expect(h.chrome.actions).toEqual([]);
  });

  it("tells the agent plainly when Chrome isn't connected", async () => {
    const h = await harness();
    h.chrome.connected = false;
    const result = await h.call("browser_snapshot");
    expect(result.isError).toBe(true);
    expect(h.textOf(result)).toMatch(/Chrome isn't connected/);
  });

  it("a finished task's tool address stops working", async () => {
    const h = await harness();
    await h.core.tasks.stop(h.taskId);
    const response = await fetch(h.url, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("siteOf keeps only http(s) origins", () => {
    expect(siteOf("https://github.com/x?y")).toBe("https://github.com");
    expect(siteOf("chrome://settings")).toBeUndefined();
    expect(siteOf("not a url")).toBeUndefined();
  });
});

describe("Chrome bridge", () => {
  async function bridge() {
    const b = new BrowserBridge({ token: "right-code", port: 0 });
    const port = await b.start();
    cleanup.push(() => b.close());
    return { b, url: `ws://127.0.0.1:${port}` };
  }

  const connect = (url: string, origin: string) =>
    new Promise<{ ws: WebSocket; opened: boolean }>((resolve) => {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      ws.once("open", () => resolve({ ws, opened: true }));
      ws.once("unexpected-response", () => resolve({ ws, opened: false }));
      ws.once("error", () => resolve({ ws, opened: false }));
    });

  it("refuses connections that don't come from a Chrome extension (e.g. a web page)", async () => {
    const { url } = await bridge();
    const { opened } = await connect(url, "https://evil.example");
    expect(opened).toBe(false);
  });

  it("refuses an extension with the wrong code", async () => {
    const { b, url } = await bridge();
    const { ws } = await connect(url, "chrome-extension://abc");
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(JSON.stringify({ type: "hello", token: "wrong-code" }));
    expect(await closed).toBe(4001);
    expect(b.connected).toBe(false);
  });

  it("works with the right code: says ready, and runs operations in Chrome", async () => {
    const { b, url } = await bridge();
    const { ws } = await connect(url, "chrome-extension://abc");
    const ready = new Promise<string>((resolve) => ws.once("message", (d) => resolve(String(d))));
    ws.send(JSON.stringify({ type: "hello", token: "right-code" }));
    expect(JSON.parse(await ready)).toEqual({ type: "ready" });
    expect(b.connected).toBe(true);

    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "call") {
        ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, value: { op: m.op } }));
      }
    });
    expect(await b.call("info")).toEqual({ op: "info" });
  });

  it("says plainly when Chrome isn't connected, and fails pending calls on disconnect", async () => {
    const { b, url } = await bridge();
    await expect(b.call("info")).rejects.toThrow(/Chrome isn't connected/);

    const { ws } = await connect(url, "chrome-extension://abc");
    const ready = new Promise((resolve) => ws.once("message", resolve));
    ws.send(JSON.stringify({ type: "hello", token: "right-code" }));
    await ready;
    const pending = b.call("snapshot");
    ws.close();
    await expect(pending).rejects.toThrow(/disconnected/);
  });
});
