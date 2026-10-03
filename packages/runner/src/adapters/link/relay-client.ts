import WebSocket from "ws";

/**
 * The computer's side of the relay (topology B, §1): dials out to your relay
 * and keeps a control connection open; for each phone that arrives it opens
 * one more connection and hands it to the link server, which treats it like
 * any direct connection — same challenge, same end-to-end encryption.
 */
export type RelayClientOptions = {
  /** e.g. wss://relay.example.com */
  relay: string;
  /** MALVES_RELAY_TOKEN: proves to the relay this is your computer. */
  token: string;
  /** This runner's public key: phones find the computer by it. */
  key: string;
  /** Takes a connection from a phone, as if it had arrived directly. */
  adopt(ws: WebSocket): void;
  onStatus?(connected: boolean): void;
  maxBackoffMs?: number;
};

const MAX_FRAME_BYTES = 256 * 1024;

export class RelayClient {
  private control: WebSocket | undefined;
  private stopped = false;
  private attempt = 0;
  private retry: NodeJS.Timeout | undefined;

  constructor(private readonly o: RelayClientOptions) {}

  /** What the pairing QR code carries: where phones reach this computer. */
  get phoneUrl(): string {
    return `${this.base}/phone?to=${encodeURIComponent(this.o.key)}`;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.control?.close(1000);
  }

  private get base(): string {
    return this.o.relay.replace(/\/+$/, "");
  }

  private get auth() {
    return { headers: { authorization: `Bearer ${this.o.token}` }, maxPayload: MAX_FRAME_BYTES };
  }

  private connect(): void {
    const ws = new WebSocket(
      `${this.base}/runner?key=${encodeURIComponent(this.o.key)}`,
      this.auth,
    );
    this.control = ws;
    ws.on("open", () => {
      this.attempt = 0;
      this.o.onStatus?.(true);
    });
    ws.on("message", (raw) => {
      const id = incoming(raw.toString());
      if (id) this.pickUp(id);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (this.control !== ws) return;
      this.o.onStatus?.(false);
      if (this.stopped) return;
      const ceiling = Math.min(this.o.maxBackoffMs ?? 30_000, 1000 * 2 ** this.attempt++);
      this.retry = setTimeout(() => this.connect(), ceiling / 2 + Math.random() * (ceiling / 2));
    });
  }

  private pickUp(id: string): void {
    const ws = new WebSocket(`${this.base}/runner/accept?id=${encodeURIComponent(id)}`, this.auth);
    ws.on("error", () => {});
    ws.once("open", () => this.o.adopt(ws));
  }
}

function incoming(text: string): string | undefined {
  try {
    const message = JSON.parse(text) as { type?: unknown; id?: unknown };
    return message.type === "incoming" && typeof message.id === "string" ? message.id : undefined;
  } catch {
    return undefined;
  }
}
