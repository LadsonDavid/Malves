import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

/**
 * The relay for topology B (§1): a blind pipe on your own server, so the phone
 * can reach your computer without Tailscale and your computer only dials out.
 *
 *   computer ──/runner (token)──────▶ relay   one control connection, kept open
 *   phone ─────/phone?to=<key>──────▶ relay   "incoming <id>" to the computer
 *   computer ──/runner/accept?id (token)───▶  relay joins the two, byte for byte
 *
 * Everything between phone and computer is already end-to-end encrypted with a
 * challenge handshake (§4), so the relay can't read or forge anything; the
 * token only stops strangers from registering as your computer.
 */
export type RelayOptions = {
  /** Only computers presenting this may register. */
  token: string;
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** How long a phone waits for the computer to pick up. */
  acceptTimeoutMs?: number;
  heartbeatMs?: number;
};

/** Same limit as the phone link itself. */
const MAX_FRAME_BYTES = 256 * 1024;
/** Phones waiting at once for one computer. */
const MAX_WAITING = 20;
/** "Try again later": the phone keeps retrying, as when the computer is off. */
const TRY_LATER = 1013;

type Waiting = { phone: WebSocket; buffered: Array<[RawData, boolean]>; timer: NodeJS.Timeout };

export class Relay {
  private server: Server | undefined;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** The computer's public key (as the phone asks for it) → its control connection. */
  private readonly computers = new Map<string, WebSocket>();
  private readonly waiting = new Map<string, Waiting & { computer: string }>();
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly alive = new WeakSet<WebSocket>();

  constructor(private readonly o: RelayOptions) {}

  async start(): Promise<number> {
    const server = createServer((_req, res) => res.writeHead(404).end("malves relay"));
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.port ?? 0, this.o.host ?? "127.0.0.1", resolve);
    });
    this.heartbeat = setInterval(() => this.ping(), this.o.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
    return (server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://relay");
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\n\r\n`);
    };
    const open = (then: (ws: WebSocket) => void) =>
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.alive.add(ws);
        ws.on("pong", () => this.alive.add(ws));
        then(ws);
      });

    if (url.pathname === "/phone") {
      const to = url.searchParams.get("to") ?? "";
      return open((phone) => this.phone(phone, to));
    }
    if (url.pathname !== "/runner" && url.pathname !== "/runner/accept") return reject(404);
    if (!this.authorized(req)) return reject(401);
    if (url.pathname === "/runner") {
      const key = url.searchParams.get("key") ?? "";
      if (!key) return reject(404);
      return open((ws) => this.computer(ws, key));
    }
    const id = url.searchParams.get("id") ?? "";
    const waiting = this.waiting.get(id);
    if (!waiting) return reject(404);
    return open((ws) => this.join(id, ws));
  }

  private authorized(req: IncomingMessage): boolean {
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const expected = Buffer.from(this.o.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** A computer registers; a newer registration replaces an older one. */
  private computer(ws: WebSocket, key: string): void {
    this.computers.get(key)?.close(4000, "Replaced by a newer connection");
    this.computers.set(key, ws);
    ws.on("close", () => {
      if (this.computers.get(key) === ws) this.computers.delete(key);
    });
  }

  /** A phone arrives: ask its computer to pick up, and hold what it sends meanwhile. */
  private phone(phone: WebSocket, to: string): void {
    const computer = this.computers.get(to);
    const queued = [...this.waiting.values()].filter((w) => w.computer === to).length;
    if (!computer || queued >= MAX_WAITING) {
      phone.close(TRY_LATER, "Your computer isn't connected to the relay");
      return;
    }
    const id = randomBytes(16).toString("base64url");
    const timer = setTimeout(() => {
      this.waiting.delete(id);
      phone.close(TRY_LATER, "Your computer didn't answer");
    }, this.o.acceptTimeoutMs ?? 10_000);
    const waiting = { phone, computer: to, buffered: [] as Array<[RawData, boolean]>, timer };
    phone.on("message", (data, binary) => waiting.buffered.push([data, binary]));
    phone.once("close", () => {
      clearTimeout(timer);
      this.waiting.delete(id);
    });
    this.waiting.set(id, waiting);
    computer.send(JSON.stringify({ type: "incoming", id }));
  }

  /** The computer picked up: from now on, every frame passes through unchanged. */
  private join(id: string, computer: WebSocket) {
    const waiting = this.waiting.get(id);
    if (!waiting) return computer.close(TRY_LATER, "The phone left");
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    const { phone } = waiting;
    phone.removeAllListeners("message");
    pipe(phone, computer);
    pipe(computer, phone);
    for (const [data, binary] of waiting.buffered) computer.send(data, { binary });
  }

  /** Drops connections that stopped answering (a phone that lost signal). */
  private ping(): void {
    for (const ws of this.wss.clients) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }
}

/** Frames one way, and the close — with its code, so the phone still sees "revoked" etc. */
function pipe(from: WebSocket, to: WebSocket): void {
  from.on("message", (data, binary) => {
    if (to.readyState === to.OPEN) to.send(data, { binary });
  });
  from.on("close", (code, reason) => {
    if (to.readyState === to.OPEN || to.readyState === to.CONNECTING) {
      to.close(closable(code), reason.toString());
    }
  });
}

/** Codes that may be sent in a close frame; anything else becomes a plain "going away". */
function closable(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1001;
}
