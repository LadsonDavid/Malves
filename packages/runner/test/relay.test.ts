import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCore, type Notifier } from "@malves/core";
import { generateKeyPair, LinkClient, type LinkStatus, type Welcome } from "@malves/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Relay } from "../../relay/src/relay.js";
import { AcpHost } from "../src/adapters/acp/host.js";
import { RelayClient } from "../src/adapters/link/relay-client.js";
import { LinkServer } from "../src/adapters/link/server.js";
import { SqliteStore } from "../src/adapters/sqlite/store.js";
import { randomIds, systemClock } from "../src/system.js";

/**
 * Topology B end to end: phone → relay ← computer, all real WebSockets. The
 * computer only dials out; the phone's link (handshake, encryption, close
 * codes) passes through the relay unchanged.
 */
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const TOKEN = "relay-token-0123456789abcdef";

async function setup(token = TOKEN) {
  const relay = new Relay({ token: TOKEN, port: 0, acceptTimeoutMs: 2000 });
  const port = await relay.start();
  cleanup.push(() => relay.close());

  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "malves-relay-")));
  const store = new SqliteStore(path.join(dir, "malves.db"));
  const noPush: Notifier = { questionOpened: async () => {} };
  const core = createCore({
    store,
    clock: systemClock,
    ids: randomIds,
    notifier: noPush,
    host: new AcpHost(),
    agents: new Map(),
    questionTimeoutMs: 10_000,
  });
  const keys = generateKeyPair();
  const statuses: boolean[] = [];
  const client: RelayClient = new RelayClient({
    relay: `ws://127.0.0.1:${port}`,
    token,
    key: keys.publicKey,
    adopt: (ws) => server.accept(ws),
    onStatus: (on) => statuses.push(on),
    maxBackoffMs: 200,
  });
  // Listening only on 127.0.0.1: phones can reach it only through the relay.
  const server = new LinkServer(core, {
    host: "127.0.0.1",
    port: 0,
    keys,
    computer: "home-pc",
    publicUrl: client.phoneUrl,
    agents: { list: () => [], subscribe: () => () => {}, checkAll: async () => {} },
  });
  await server.start();
  client.start();
  cleanup.push(() => store.close());
  cleanup.push(() => server.close());
  cleanup.push(() => client.close());
  return { core, server, statuses, keys };
}

function phone(r: Awaited<ReturnType<typeof setup>>) {
  const offer = r.server.offerPairing();
  const seen: { statuses: LinkStatus[]; welcome?: Welcome; reason?: string } = { statuses: [] };
  const client = new LinkClient({
    url: offer.url,
    runnerKey: offer.runner,
    keys: generateKeyPair(),
    pair: { code: offer.code, name: "Pixel 8" },
    onWelcome: (w) => {
      seen.welcome = w;
    },
    onStatus: (s, why) => {
      seen.statuses.push(s);
      if (why) seen.reason = why;
    },
    maxBackoffMs: 200,
  });
  client.connect();
  cleanup.push(() => client.close());
  return { client, seen, offer };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("relay (topology B)", () => {
  it("pairs and talks through the relay; 'revoked' still reaches the phone", async () => {
    const r = await setup();
    await waitFor(() => r.statuses.includes(true), "the computer to register");
    const p = phone(r);
    expect(p.offer.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/phone\?to=/);

    await waitFor(() => p.seen.statuses.at(-1) === "online", "pairing through the relay");
    expect(p.seen.welcome?.computer).toBe("home-pc");
    expect(await p.client.checkAgents()).toMatchObject({ ok: true });

    const [device] = r.core.devices.list();
    r.core.devices.revoke(device?.id ?? "");
    await waitFor(() => p.seen.statuses.at(-1) === "rejected", "the revocation");
    expect(p.seen.reason).toBe("This phone was revoked on the computer");
  });

  it("a computer with the wrong relay token can't register; its phone keeps waiting", async () => {
    const r = await setup("wrong-token-0123456789abcdef");
    const p = phone(r);
    await waitFor(() => p.seen.statuses.filter((s) => s === "offline").length >= 2, "retries");
    expect(r.statuses).not.toContain(true);
    expect(p.seen.statuses).not.toContain("online");
    expect(p.seen.statuses).not.toContain("rejected"); // it will connect once the computer does
  });
});
