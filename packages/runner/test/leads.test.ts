import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { signalstack } from "../src/adapters/leads/signalstack.js";

/** signalstack's `GET /api/leads`, played by a real local HTTP server. */
const servers: Array<() => void> = [];
afterEach(() => {
  for (const close of servers.splice(0)) close();
});

async function engine(answer: (req: IncomingMessage) => { status: number; body: unknown }) {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    const { status, body } = answer(req);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const lead = {
  domain: "hot.example",
  name: "Hot Co",
  tier: "hot",
  score: 80,
  fit: 0.9,
  intent: 0.8,
  types: ["intent"],
  why: "Asked for a tool like this",
  trigger: "Read the pricing page",
  opener: "Saw you were comparing tools",
  contact: null,
  signals: 2,
  last_signal: "2026-10-01T00:00:00+00:00",
};

describe("leads from signalstack", () => {
  it("fetches this week's leads, sending the key as a header, never in the URL", async () => {
    const e = await engine(() => ({ status: 200, body: { generated_at: "now", leads: [lead] } }));
    expect(await signalstack({ url: e.url, key: "s3cret" }).fetch()).toEqual([lead]);
    expect(e.seen[0]?.url).toBe("/api/leads?limit=25");
    expect(e.seen[0]?.headers["x-key"]).toBe("s3cret");
  });

  it("explains a wrong key, an engine that's down, and an answer it doesn't understand", async () => {
    const refused = await engine(() => ({ status: 401, body: { detail: "nope" } }));
    await expect(signalstack({ url: refused.url }).fetch()).rejects.toThrow(/MALVES_LEADS_KEY/);

    const odd = await engine(() => ({ status: 200, body: { leads: [{ domain: 1 }] } }));
    await expect(signalstack({ url: odd.url }).fetch()).rejects.toThrow(/shape/);

    // Nothing listens on port 9 (discard) on test machines.
    await expect(signalstack({ url: "http://127.0.0.1:9" }).fetch()).rejects.toThrow(
      /Can't reach the lead engine/,
    );
  });
});
