import {
  Challenge,
  Channel,
  type KeyPair,
  type PairingInvite,
  parseFrame,
  randomBytes,
  safeJson,
  toBase64Url,
} from "./channel.js";
import type { LoggedEvent } from "./events.js";
import { type Command, LINK_VERSION, type Reply, type Welcome, type Wish } from "./link.js";

/** The subset of the WebSocket API the client needs (browser, Node 22 and React Native all have it). */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type OpenSocket = (url: string) => SocketLike;

export const defaultOpenSocket: OpenSocket = (url) =>
  new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url);

export type AckResult = { result: string; data?: unknown };

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Pairs this phone with a runner, using the QR invite. Resolves with the new device id. */
export function pair(
  invite: PairingInvite,
  keyPair: KeyPair,
  name: string,
  openSocket: OpenSocket = defaultOpenSocket,
  timeoutMs = 15_000,
): Promise<{ runnerId: string; deviceId: string; name: string }> {
  return new Promise((resolve, reject) => {
    const socket = openSocket(invite.url);
    const channel = new Channel(keyPair.secretKey, invite.publicKey);
    let settled = false;
    const finish = (
      error?: Error,
      value?: { runnerId: string; deviceId: string; name: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Pairing timed out")), timeoutMs);

    let challenged = false;
    socket.onmessage = ({ data }) => {
      try {
        const text = String(data);
        if (!challenged) {
          const challenge = Challenge.parse(safeJson(text));
          challenged = true;
          socket.send(
            channel.seal(
              { t: "pair", v: LINK_VERSION, r: challenge.r, secret: invite.secret, name },
              keyPair.publicKey,
            ),
          );
          return;
        }
        const reply = channel.open(parseFrame(text)) as Reply;
        if (reply.t === "paired") {
          finish(undefined, {
            runnerId: reply.runner_id,
            deviceId: reply.device_id,
            name: reply.name,
          });
        } else if (reply.t === "error") {
          finish(new CommandError(reply.code, reply.message));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onclose = () => finish(new Error("The computer closed the connection"));
    socket.onerror = () => finish(new Error("Could not reach the computer"));
  });
}

export type LinkStatus =
  | { state: "connecting"; attempt: number }
  | { state: "online"; lastSeen: number }
  | { state: "offline"; lastSeen: number | undefined; retryInMs: number };

export type LinkClientOptions = {
  url: string;
  runnerPublicKey: Uint8Array;
  keyPair: KeyPair;
  wish?: Wish[];
  /** Resume after this sequence number ("Resume from a position"). */
  sinceSeq?: number;
  openSocket?: OpenSocket;
  onEvent?: (event: LoggedEvent) => void;
  onWelcome?: (welcome: Welcome) => void;
  onStatus?: (status: LinkStatus) => void;
  /** No message for this long means the connection is dead. Heartbeats come every 30 s. */
  silenceMs?: number;
  backoff?: { baseMs: number; maxMs: number };
};

type Pending = { command: Command; resolve: (r: AckResult) => void; reject: (e: Error) => void };

/**
 * A long-lived, self-healing connection to one runner. Commands are sent at
 * least once — re-sent after a reconnect until acknowledged — and the runner
 * applies each command id once. Events arrive at least once and are
 * de-duplicated here by sequence number.
 */
export class LinkClient {
  private socket: SocketLike | undefined;
  private channel: Channel | undefined;
  private ready = false;
  private closed = false;
  private attempt = 0;
  private lastSeq: number;
  private lastSeen: number | undefined;
  private readonly pending = new Map<string, Pending>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: LinkClientOptions) {
    this.lastSeq = o.sinceSeq ?? 0;
  }

  get seq(): number {
    return this.lastSeq;
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.silenceTimer);
    this.socket?.close();
    for (const p of this.pending.values()) p.reject(new Error("Link stopped"));
    this.pending.clear();
  }

  /** Sends a command; resolves when the runner acknowledges it. */
  send(command: Command): Promise<AckResult> {
    return new Promise((resolve, reject) => {
      this.pending.set(command.id, { command, resolve, reject });
      if (this.ready) this.transmit(command);
    });
  }

  private open(): void {
    this.attempt += 1;
    this.o.onStatus?.({ state: "connecting", attempt: this.attempt });
    const socket = (this.o.openSocket ?? defaultOpenSocket)(this.o.url);
    this.socket = socket;
    const channel = new Channel(this.o.keyPair.secretKey, this.o.runnerPublicKey);
    this.channel = channel;
    this.ready = false;
    let challenged = false;
    this.watchSilence();

    socket.onmessage = ({ data }) => {
      if (socket !== this.socket) return;
      this.seen();
      try {
        const text = String(data);
        if (!challenged) {
          const challenge = Challenge.parse(safeJson(text));
          challenged = true;
          socket.send(
            channel.seal(
              {
                t: "hello",
                v: LINK_VERSION,
                r: challenge.r,
                since_seq: this.lastSeq,
                wish: this.o.wish ?? ["tasks", "questions", "workspaces", "budget", "errors"],
              },
              this.o.keyPair.publicKey,
            ),
          );
          return;
        }
        this.handle(channel.open(parseFrame(text)) as Reply);
      } catch {
        socket.close();
      }
    };
    socket.onclose = () => {
      if (socket === this.socket) this.dropped();
    };
    socket.onerror = () => socket.close();
  }

  private handle(reply: Reply): void {
    switch (reply.t) {
      case "welcome":
        this.ready = true;
        this.attempt = 0;
        this.o.onWelcome?.(reply);
        this.o.onStatus?.({ state: "online", lastSeen: this.lastSeen ?? Date.now() });
        for (const p of this.pending.values()) this.transmit(p.command);
        break;
      case "event":
        if (reply.event.seq <= this.lastSeq) return;
        this.lastSeq = reply.event.seq;
        this.o.onEvent?.(reply.event);
        break;
      case "ack": {
        const p = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        p?.resolve(
          reply.data === undefined
            ? { result: reply.result }
            : { result: reply.result, data: reply.data },
        );
        break;
      }
      case "error": {
        if (!reply.id) {
          // A connection-level error: the runner will close the socket.
          if (reply.code === "not_paired") this.closed = true;
          return;
        }
        const p = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        p?.reject(new CommandError(reply.code, reply.message));
        break;
      }
      case "heartbeat":
      case "paired":
        break;
    }
  }

  private transmit(command: Command): void {
    try {
      if (this.channel) this.socket?.send(this.channel.seal(command));
    } catch {
      this.socket?.close();
    }
  }

  private seen(): void {
    this.lastSeen = Date.now();
    this.watchSilence();
  }

  private watchSilence(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.socket?.close(), this.o.silenceMs ?? 75_000);
  }

  private dropped(): void {
    this.ready = false;
    clearTimeout(this.silenceTimer);
    if (this.closed) return;
    // Capped exponential backoff with full jitter.
    const { baseMs, maxMs } = this.o.backoff ?? { baseMs: 1000, maxMs: 60_000 };
    const cap = Math.min(maxMs, baseMs * 2 ** Math.min(this.attempt, 16));
    const retryInMs = Math.floor(Math.random() * cap) + 1;
    this.o.onStatus?.({ state: "offline", lastSeen: this.lastSeen, retryInMs });
    this.retryTimer = setTimeout(() => this.open(), retryInMs);
  }
}

/** A fresh command id. */
export function commandId(): string {
  return toBase64Url(randomBytes(12));
}
