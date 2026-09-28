import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/**
 * The relay for topology B (§1): a blind forwarder on the owner's server.
 *
 * - A runner dials out to /runner/<runnerId> with the relay token, and keeps
 *   that one connection open. Nothing is opened on the home network.
 * - A phone connects to /phone/<runnerId>. The relay gives it a stream id and
 *   passes its frames, unread, down the runner's connection.
 *
 * The relay never sees keys or plaintext: the phone and runner run the same
 * end-to-end encrypted channel as over Tailscale, and the runner — not the
 * relay — decides who is paired.
 *
 * Between relay and runner, each frame is JSON: {c, open} | {c, d} | {c, close},
 * where c is the phone stream id and d the opaque frame text.
 */

export type RelayOptions = {
  host: string;
  port: number;
  /** Shared secret the owner's runner presents. */
  token: string;
  /** Optional HTTP handler for other routes, e.g. the lead engine (step 8). */
  http?: (req: IncomingMessage, res: ServerResponse) => boolean;
  maxPhonesPerRunner?: number;
  maxConnectionsPerIp?: number;
  maxFrameBytes?: number;
  /** Frames per second a phone may send before it is disconnected. */
  phoneRate?: number;
  pingMs?: number;
};

export type Relay = { url: string; close(): Promise<void> };

type RunnerLink = { ws: WebSocket; phones: Map<string, WebSocket> };

const RUNNER_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function startRelay(o: RelayOptions): Promise<Relay> {
  const maxPhones = o.maxPhonesPerRunner ?? 8;
  const maxPerIp = o.maxConnectionsPerIp ?? 20;
  const maxFrame = o.maxFrameBytes ?? 256 * 1024;
  const rate = o.phoneRate ?? 50;
  const token = Buffer.from(o.token);

  const runners = new Map<string, RunnerLink>();
  const perIp = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrame + 1024 });

  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (o.http?.(req, res)) return;
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    const ip = req.socket.remoteAddress ?? "?";
    const count = perIp.get(ip) ?? 0;
    if (count >= maxPerIp) return reject(socket, 429);
    const match = /^\/(runner|phone)\/([^/?]+)$/.exec(req.url ?? "");
    if (!match || !RUNNER_ID.test(match[2] as string)) return reject(socket, 404);
    const [, role, runnerId] = match as unknown as [string, "runner" | "phone", string];

    if (role === "runner" && !validToken(req.headers.authorization, token))
      return reject(socket, 401);
    if (role === "phone") {
      const runner = runners.get(runnerId);
      if (!runner) return reject(socket, 503);
      if (runner.phones.size >= maxPhones) return reject(socket, 429);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, count + 1);
      ws.once("close", () => {
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left <= 0) perIp.delete(ip);
        else perIp.set(ip, left);
      });
      if (role === "runner") acceptRunner(runnerId, ws);
      else acceptPhone(runnerId, ws);
    });
  });

  function acceptRunner(runnerId: string, ws: WebSocket): void {
    // A newer connection from the same runner replaces the old one.
    const old = runners.get(runnerId);
    if (old) old.ws.close(4000, "replaced");
    const link: RunnerLink = { ws, phones: new Map() };
    runners.set(runnerId, link);
    keepAlive(ws);

    ws.on("message", (data: RawData, isBinary) => {
      if (isBinary) return;
      let frame: { c?: unknown; d?: unknown; close?: unknown };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof frame.c !== "string") return;
      const phone = link.phones.get(frame.c);
      if (!phone) return;
      if (frame.close === true) phone.close();
      else if (typeof frame.d === "string") phone.send(frame.d);
    });
    ws.on("close", () => {
      if (runners.get(runnerId) === link) runners.delete(runnerId);
      for (const phone of link.phones.values()) phone.close(4503, "computer went offline");
    });
    ws.on("error", () => ws.terminate());
  }

  function acceptPhone(runnerId: string, ws: WebSocket): void {
    const link = runners.get(runnerId);
    if (!link) return void ws.close(4503, "computer offline");
    const c = randomBytes(9).toString("base64url");
    link.phones.set(c, ws);
    link.ws.send(JSON.stringify({ c, open: true }));
    keepAlive(ws);

    let tokens = rate;
    const refill = setInterval(() => {
      tokens = rate;
    }, 1000);
    refill.unref();

    ws.on("message", (data: RawData, isBinary) => {
      tokens -= 1;
      const text = data.toString();
      if (isBinary || tokens < 0 || Buffer.byteLength(text) > maxFrame)
        return void ws.close(4008, "policy");
      if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify({ c, d: text }));
    });
    ws.on("close", () => {
      clearInterval(refill);
      link.phones.delete(c);
      if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify({ c, close: true }));
    });
    ws.on("error", () => ws.terminate());
  }

  function keepAlive(ws: WebSocket): void {
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const timer = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, o.pingMs ?? 30_000);
    timer.unref();
    ws.once("close", () => clearInterval(timer));
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      const { address, port } = server.address() as AddressInfo;
      resolve({
        url: `ws://${address.includes(":") ? `[${address}]` : address}:${port}`,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

function validToken(header: string | undefined, token: Buffer): boolean {
  const presented = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  return presented.length === token.length && timingSafeEqual(presented, token);
}

function reject(socket: Duplex, status: number): void {
  const text = {
    401: "Unauthorized",
    404: "Not Found",
    429: "Too Many Requests",
    503: "Service Unavailable",
  }[status];
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
}
