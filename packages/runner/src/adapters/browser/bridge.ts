import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

/** The port malves' Chrome extension connects to (fixed: the extension can't discover it). */
export const EXTENSION_PORT = 7718;

/** What the browser tools need from Chrome. A fake stands in for it in tests. */
export interface Browser {
  readonly connected: boolean;
  call(op: string, args?: Record<string, unknown>): Promise<unknown>;
}

const HELLO_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 60_000;
const PING_MS = 20_000;

/**
 * The connection to malves' Chrome extension (§5). Only on this computer, only
 * from a Chrome extension, and only with the secret token — a web page can open
 * a WebSocket to 127.0.0.1 too, but it can't claim a `chrome-extension://`
 * origin, and it doesn't have the token.
 */
export class BrowserBridge implements Browser {
  private wss: WebSocketServer | undefined;
  private extension: WebSocket | undefined;
  private ping: NodeJS.Timeout | undefined;
  private next = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly listeners = new Set<(connected: boolean) => void>();

  constructor(private readonly o: { token: string; port?: number }) {}

  /** Starts listening on 127.0.0.1. Resolves with the port. */
  async start(): Promise<number> {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.o.port ?? EXTENSION_PORT,
      maxPayload: 2 * 1024 * 1024,
      verifyClient: ({ origin }: { origin?: string }) =>
        typeof origin === "string" && origin.startsWith("chrome-extension://"),
    });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("connection", (ws) => this.accept(ws));
    // Traffic keeps the extension's service worker awake, and the link alive.
    this.ping = setInterval(() => this.send({ type: "ping" }), PING_MS);
    this.ping.unref();
    return (wss.address() as AddressInfo).port;
  }

  get connected(): boolean {
    return this.extension !== undefined;
  }

  onChange(listener: (connected: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs one operation in Chrome (see the extension's background script). */
  call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.extension;
    if (!ws) {
      return Promise.reject(
        new Error(
          "Chrome isn't connected to malves. On the computer, open Chrome and check the malves extension is on.",
        ),
      );
    }
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const ms = op === "navigate" || op === "back" ? NAVIGATE_TIMEOUT_MS : CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome didn't answer "${op}" in time.`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "call", id, op, args }));
    });
  }

  async close(): Promise<void> {
    clearInterval(this.ping);
    this.failAll("malves is shutting down.");
    const wss = this.wss;
    if (!wss) return;
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private accept(ws: WebSocket): void {
    let trusted = false;
    const deadline = setTimeout(() => ws.close(4001, "No hello"), HELLO_TIMEOUT_MS);

    ws.on("message", (raw) => {
      const message = parse(raw);
      if (!trusted) {
        clearTimeout(deadline);
        if (message?.type !== "hello" || !sameSecret(message.token, this.o.token)) {
          ws.close(4001, "Wrong extension code");
          return;
        }
        trusted = true;
        // One extension at a time: a newer connection replaces an older one.
        const previous = this.extension;
        this.extension = ws;
        previous?.close(4000, "Replaced");
        ws.send(JSON.stringify({ type: "ready" }));
        this.notify();
        return;
      }
      if (message?.type === "result" && typeof message.id === "string") {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(new Error(String(message.error ?? "Chrome couldn't do that.")));
      }
    });

    ws.on("close", () => {
      clearTimeout(deadline);
      if (this.extension !== ws) return;
      this.extension = undefined;
      this.failAll("Chrome disconnected.");
      this.notify();
    });
  }

  private send(message: unknown): void {
    this.extension?.send(JSON.stringify(message));
  }

  private failAll(reason: string): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.connected);
  }
}

type Message = {
  type?: unknown;
  id?: unknown;
  token?: unknown;
  ok?: unknown;
  value?: unknown;
  error?: unknown;
};

function parse(raw: RawData): Message | undefined {
  try {
    const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)) as unknown;
    return typeof value === "object" && value !== null ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
}

/** Compares secrets without leaking, through timing, how much of a guess was right. */
function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
