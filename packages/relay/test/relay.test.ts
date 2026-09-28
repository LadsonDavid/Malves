import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Relay, startRelay } from "../src/relay.js";

const TOKEN = "t".repeat(40);
const RUNNER = "runnerAbc123";
const open: Array<{ close(): unknown }> = [];

afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
});

async function relay(extra: Partial<Parameters<typeof startRelay>[0]> = {}): Promise<Relay> {
  const r = await startRelay({ host: "127.0.0.1", port: 0, token: TOKEN, ...extra });
  open.push(r);
  return r;
}

function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  open.push({ close: () => ws.terminate() });
  const messages: string[] = [];
  ws.on("message", (d) => messages.push(d.toString()));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  const next = async (n: number) => {
    for (let i = 0; i < 200 && messages.length < n; i++)
      await new Promise((r) => setTimeout(r, 10));
    return messages[n - 1];
  };
  return { ws, messages, opened, closed, next };
}

describe("relay", () => {
  it("forwards frames both ways without interpreting them", async () => {
    const r = await relay();
    const runner = connect(`${r.url}/runner/${RUNNER}`, { authorization: `Bearer ${TOKEN}` });
    await runner.opened;
    const phone = connect(`${r.url}/phone/${RUNNER}`);
    await phone.opened;

    const { c, open: isOpen } = JSON.parse((await runner.next(1)) as string);
    expect(isOpen).toBe(true);
    phone.ws.send("opaque-ciphertext-1");
    expect(JSON.parse((await runner.next(2)) as string)).toEqual({ c, d: "opaque-ciphertext-1" });
    runner.ws.send(JSON.stringify({ c, d: "opaque-ciphertext-2" }));
    expect(await phone.next(1)).toBe("opaque-ciphertext-2");

    phone.ws.close();
    expect(JSON.parse((await runner.next(3)) as string)).toEqual({ c, close: true });
  });

  it("requires the token from runners", async () => {
    const r = await relay();
    await expect(connect(`${r.url}/runner/${RUNNER}`).opened).rejects.toThrow("401");
    await expect(
      connect(`${r.url}/runner/${RUNNER}`, { authorization: `Bearer ${"x".repeat(40)}` }).opened,
    ).rejects.toThrow("401");
  });

  it("refuses phones for a computer that isn't connected, and bad paths", async () => {
    const r = await relay();
    await expect(connect(`${r.url}/phone/${RUNNER}`).opened).rejects.toThrow("503");
    await expect(connect(`${r.url}/phone/a`).opened).rejects.toThrow("404");
    await expect(connect(`${r.url}/admin`).opened).rejects.toThrow("404");
  });

  it("disconnects a phone that floods", async () => {
    const r = await relay({ phoneRate: 5 });
    const runner = connect(`${r.url}/runner/${RUNNER}`, { authorization: `Bearer ${TOKEN}` });
    await runner.opened;
    const phone = connect(`${r.url}/phone/${RUNNER}`);
    await phone.opened;
    for (let i = 0; i < 20; i++) phone.ws.send("x");
    expect(await phone.closed).toBe(4008);
  });

  it("limits phones per computer", async () => {
    const r = await relay({ maxPhonesPerRunner: 1 });
    const runner = connect(`${r.url}/runner/${RUNNER}`, { authorization: `Bearer ${TOKEN}` });
    await runner.opened;
    await connect(`${r.url}/phone/${RUNNER}`).opened;
    await expect(connect(`${r.url}/phone/${RUNNER}`).opened).rejects.toThrow("429");
  });

  it("closes phones when their computer goes away", async () => {
    const r = await relay();
    const runner = connect(`${r.url}/runner/${RUNNER}`, { authorization: `Bearer ${TOKEN}` });
    await runner.opened;
    const phone = connect(`${r.url}/phone/${RUNNER}`);
    await phone.opened;
    runner.ws.close();
    expect(await phone.closed).toBe(4503);
  });

  it("answers health checks", async () => {
    const r = await relay();
    const res = await fetch(`${r.url.replace("ws://", "http://")}/healthz`);
    expect(await res.text()).toBe("ok");
  });
});

describe("leads route", () => {
  it("passes GET /leads/api/* to the lead engine with the key, and nothing else", async () => {
    const { createServer } = await import("node:http");
    const { leadsRoute } = await import("../src/leads.js");
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const engine = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end('{"leads":[]}');
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
    open.push({ close: () => engine.close() });
    const port = (engine.address() as { port: number }).port;
    const r = await relay({ http: leadsRoute(`http://127.0.0.1:${port}`) });
    const base = r.url.replace("ws://", "http://");

    const ok = await fetch(`${base}/leads/api/leads?limit=5`, {
      headers: { authorization: "Bearer k" },
    });
    expect(await ok.json()).toEqual({ leads: [] });
    expect(seen).toEqual([{ url: "/api/leads?limit=5", auth: "Bearer k" }]);

    expect((await fetch(`${base}/leads/ops/backup`)).status).toBe(404);
    expect((await fetch(`${base}/leads/`)).status).toBe(404);
    expect((await fetch(`${base}/leads/api/../ops/run`)).status).toBe(404);
    expect((await fetch(`${base}/leads/api/leads`, { method: "POST" })).status).toBe(405);
    expect(seen).toHaveLength(1);
  });
});
