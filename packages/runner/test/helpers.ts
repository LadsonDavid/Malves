import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "@malves/core";
import {
  decodeInvite,
  generateKeyPair,
  type KeyPair,
  LinkClient,
  type LinkClientOptions,
  type LoggedEvent,
  pair,
  type Welcome,
} from "@malves/protocol";
import { MemorySecrets } from "../src/adapters/secrets/secrets.js";
import type { AgentSpec } from "../src/agents.js";
import { handleControl } from "../src/control.js";
import { type Served, type ServeOptions, serve } from "../src/serve.js";

export const demoAgentPath = fileURLToPath(new URL("../src/demo-agent.ts", import.meta.url));

export const demoSpec: AgentSpec = {
  name: "demo",
  label: "demo",
  command: command(process.execPath, [demoAgentPath]),
  requires: process.execPath,
};

export function tempDirs() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "malves-")));
  const site = path.join(dir, "site");
  mkdirSync(site);
  const home = path.join(dir, "home");
  mkdirSync(home);
  return { dir, site, home };
}

export async function startServed(options: Partial<ServeOptions> = {}, config?: object) {
  const dirs = tempDirs();
  if (config) writeFileSync(path.join(dirs.home, "config.json"), JSON.stringify(config));
  const served: Served = await serve({
    dir: dirs.home,
    questionTimeoutMs: 10_000,
    listen: "127.0.0.1:0",
    agents: [demoSpec],
    secrets: new MemorySecrets(),
    ...options,
  });
  const ws = served.runner.workspaces.register("site", dirs.site);
  return { ...dirs, served, ws };
}

/** Pairs a fresh phone key with the served runner, as the app does after scanning the QR. */
export async function pairPhone(served: Served): Promise<KeyPair & { deviceId: string }> {
  const response = await handleControl(served.runner, { cmd: "pair" }, { linkUrl: served.linkUrl });
  if (!response.ok) throw new Error(response.error);
  const invite = decodeInvite((response.data as { invite: string }).invite);
  const keys = generateKeyPair();
  const result = await pair(invite, keys, "Test phone");
  return { ...keys, deviceId: result.deviceId };
}

/** A connected LinkClient that collects events. */
export function connect(served: Served, keys: KeyPair, extra: Partial<LinkClientOptions> = {}) {
  const events: LoggedEvent[] = [];
  const welcomes: Welcome[] = [];
  const waiters: Array<{ test: (e: LoggedEvent) => boolean; resolve: (e: LoggedEvent) => void }> =
    [];
  const client = new LinkClient({
    url: served.linkUrl,
    runnerPublicKey: served.runner.identity.keyPair.publicKey,
    keyPair: keys,
    backoff: { baseMs: 20, maxMs: 100 },
    onWelcome: (w) => welcomes.push(w),
    onEvent: (e) => {
      events.push(e);
      for (const w of [...waiters]) {
        if (w.test(e)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(e);
        }
      }
    },
    ...extra,
  });
  client.start();
  const next = (test: (e: LoggedEvent) => boolean, timeoutMs = 10_000) => {
    const found = events.find(test);
    if (found) return Promise.resolve(found);
    return new Promise<LoggedEvent>((resolve, reject) => {
      waiters.push({ test, resolve });
      setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs).unref();
    });
  };
  const welcomed = () =>
    new Promise<Welcome>((resolve) => {
      const check = () =>
        welcomes.at(-1) ? resolve(welcomes.at(-1) as Welcome) : setTimeout(check, 10);
      check();
    });
  return { client, events, welcomes, next, welcomed };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
