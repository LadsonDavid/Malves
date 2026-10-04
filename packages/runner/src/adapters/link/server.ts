import type { AddressInfo } from "node:net";
import type { Core, Device } from "@malves/core";
import {
  type Ack,
  type AgentInfo,
  type AgentSessionInfo,
  CLOSE,
  Command,
  FirstFrame,
  Hello,
  type KeyPair,
  LINK_VERSION,
  type LoggedEvent,
  open,
  type PairingOffer,
  type RunnerMessage,
  randomToken,
  SealedFrame,
  seal,
} from "@malves/protocol";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { LeadSource } from "../leads/signalstack.js";

export type LinkServerOptions = {
  /** A concrete address: the Tailscale IP, a LAN IP, or 127.0.0.1. */
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** The runner's own key pair. */
  keys: KeyPair;
  /** Shown on the phone, e.g. the computer's hostname. */
  computer: string;
  agents: AgentDirectory;
  /** The lead engine, if set up (`--leads`). */
  leads?: LeadSource | undefined;
  /** An agent's saved conversations in a workspace, newest first. */
  /** A finished task's changes as a diff. */
  diff?: ((taskId: string) => string) | undefined;
  /** Where phones reach this computer when it isn't `host` itself: the relay (topology B). */
  publicUrl?: string | undefined;
  /** The ntfy subscribe link for notifications, when they're on. It changes when a phone is revoked. */
  pushLink?: (() => string | undefined) | undefined;
  listSessions?: ((agent: string, workspaceId: string) => Promise<AgentSessionInfo[]>) | undefined;
  pairingTtlMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
};

/** Which agents exist and whether each is ready — see `AgentStatus`. */
export interface AgentDirectory {
  list(): AgentInfo[];
  subscribe(listener: (agents: AgentInfo[]) => void): () => void;
  checkAll(): Promise<void>;
}

const PAGE = 500;
const MAX_FRAME_BYTES = 256 * 1024;
/** Remembered command results, so a re-sent command is answered, not re-run. */
const REMEMBERED_COMMANDS = 1000;

/**
 * The runner's end of the phone link (§4, §8). Drives the core the same way
 * the terminal does; the phone gets nothing the core wouldn't give the desktop.
 */
export class LinkServer {
  private wss: WebSocketServer | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private offer: { code: string; expiresAt: number } | undefined;
  private readonly results = new Map<string, Promise<Ack>>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly sessions = new Set<Session>();
  private address = "";
  private chrome: boolean | undefined;

  constructor(
    private readonly core: Core,
    private readonly o: LinkServerOptions,
  ) {}

  /** Starts listening. Resolves with the URL phones connect to. */
  async start(): Promise<string> {
    const wss = new WebSocketServer({
      host: this.o.host,
      port: this.o.port,
      maxPayload: MAX_FRAME_BYTES,
    });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const { port } = wss.address() as AddressInfo;
    const host = this.o.host.includes(":") ? `[${this.o.host}]` : this.o.host;
    this.address = `ws://${host}:${port}`;

    wss.on("connection", (ws) => this.accept(ws));
    this.heartbeat = setInterval(() => this.ping(), this.o.heartbeatMs ?? 30_000);
    this.heartbeat.unref();
    return this.address;
  }

  get url(): string {
    return this.address;
  }

  /**
   * A fresh one-time pairing code, valid for two minutes, for the QR code.
   * Making a new one cancels the previous one.
   */
  offerPairing(now = Date.now()): PairingOffer {
    const code = randomToken(24);
    this.offer = { code, expiresAt: now + (this.o.pairingTtlMs ?? 120_000) };
    return {
      v: LINK_VERSION,
      url: this.o.publicUrl ?? this.address,
      runner: this.o.keys.publicKey,
      code,
      computer: this.o.computer,
    };
  }

  /** Tells every phone what a running task's agent is doing (not logged). */
  activity(taskId: string, text: string): void {
    const message: RunnerMessage = {
      type: "activity",
      task_id: taskId,
      text: text.slice(0, 500),
      at: Date.now(),
    };
    for (const s of this.sessions) s.send(message);
  }

  /** Tells every phone whether Chrome is connected (and every phone that connects later). */
  setChrome(connected: boolean): void {
    this.chrome = connected;
    for (const s of this.sessions) s.send({ type: "chrome", connected });
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    const wss = this.wss;
    if (!wss) return;
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  /** Takes a phone connection — directly, or handed over by the relay client. */
  accept(ws: WebSocket): void {
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));

    const challenge = randomToken(24);
    ws.send(JSON.stringify({ type: "challenge", challenge }));
    const deadline = setTimeout(
      () => ws.close(CLOSE.BAD_MESSAGE, "No hello"),
      this.o.handshakeTimeoutMs ?? 10_000,
    );

    let session: Session | undefined;
    ws.on("message", (raw) => {
      const frame = parseJson(raw);
      if (session) return session.receive(frame);
      clearTimeout(deadline);
      session = this.handshake(ws, frame, challenge);
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      session?.dispose();
    });
  }

  private handshake(ws: WebSocket, frame: unknown, challenge: string): Session | undefined {
    const first = FirstFrame.safeParse(frame);
    const hello = first.success
      ? Hello.safeParse(open(first.data, first.data.device, this.o.keys.secretKey))
      : undefined;
    // The challenge is new for every connection, so an old hello can't be replayed.
    if (!first.success || !hello?.success || hello.data.challenge !== challenge) {
      ws.close(CLOSE.BAD_MESSAGE, "Bad hello");
      return undefined;
    }
    if (hello.data.v !== LINK_VERSION) {
      ws.close(CLOSE.VERSION, `This runner speaks link version ${LINK_VERSION}`);
      return undefined;
    }

    const key = first.data.device;
    let device: Device | undefined;
    if (hello.data.pair) {
      if (!this.consumeCode(hello.data.pair.code)) {
        ws.close(CLOSE.BAD_CODE, "The pairing code is wrong or has expired");
        return undefined;
      }
      device = this.core.devices.pair(hello.data.pair.name, key);
    } else {
      device = this.core.devices.byKey(key);
      if (!device) {
        ws.close(CLOSE.NOT_PAIRED, "This phone isn't paired with this computer");
        return undefined;
      }
    }
    const session = new Session(ws, device, key, hello.data, this.core, this);
    this.sessions.add(session);
    ws.on("close", () => this.sessions.delete(session));
    return session;
  }

  /** One use only; a wrong guess doesn't burn the code (it's 24 random bytes). */
  private consumeCode(code: string, now = Date.now()): boolean {
    const offer = this.offer;
    if (!offer || now > offer.expiresAt || offer.code !== code) return false;
    this.offer = undefined;
    return true;
  }

  /** @internal Runs a command once per id; a repeat gets the first result. */
  execute(command: Command): Promise<Ack> {
    const known = this.results.get(command.command_id);
    if (known) return known;
    const result = this.run(command);
    this.results.set(command.command_id, result);
    if (this.results.size > REMEMBERED_COMMANDS) {
      const oldest = this.results.keys().next().value;
      if (oldest !== undefined) this.results.delete(oldest);
    }
    return result;
  }

  /** @internal */
  seal(message: RunnerMessage, to: string): string {
    return JSON.stringify(seal(message, to, this.o.keys.secretKey));
  }

  /** @internal */
  open(frame: unknown, from: string): Command | undefined {
    const sealed = SealedFrame.safeParse(frame);
    if (!sealed.success) return undefined;
    const command = Command.safeParse(open(sealed.data, from, this.o.keys.secretKey));
    return command.success ? command.data : undefined;
  }

  /** @internal */
  welcome(device: Device): RunnerMessage {
    const push = this.o.pushLink?.();
    return {
      type: "welcome",
      v: LINK_VERSION,
      device_id: device.id,
      computer: this.o.computer,
      workspaces: this.core.workspaces.list().map(({ id, name }) => ({ id, name })),
      agents: this.o.agents.list(),
      last_seq: this.core.log.lastSeq,
      ...(push ? { push: { subscribe: push } } : {}),
      ...(this.chrome === undefined ? {} : { chrome: this.chrome }),
    };
  }

  /** @internal */
  subscribeAgents(listener: (agents: AgentInfo[]) => void): () => void {
    return this.o.agents.subscribe(listener);
  }

  private async run(command: Command): Promise<Ack> {
    const ack = (ok: boolean, detail?: Omit<Partial<Ack>, "type" | "command_id" | "ok">): Ack => ({
      type: "ack",
      command_id: command.command_id,
      ok,
      ...detail,
    });
    try {
      switch (command.type) {
        case "task.create": {
          const id = this.core.tasks.create({
            workspaceId: command.workspace_id,
            agent: command.agent,
            prompt: command.prompt,
            resume: command.resume,
          });
          return ack(true, { result: id });
        }
        case "task.reply":
          return ack(true, { result: this.core.tasks.reply(command.task_id, command.prompt) });
        case "changes.diff":
          if (!this.o.diff) return ack(false, { error: "Not available on this computer." });
          return ack(true, { result: this.o.diff(command.task_id) });
        case "sessions.list": {
          if (!this.o.listSessions) return ack(false, { error: "Not available on this computer." });
          const sessions = await this.o.listSessions(command.agent, command.workspace_id);
          return ack(true, { sessions });
        }
        case "answer": {
          const result = this.core.questions.answer({
            questionId: command.question_id,
            choiceId: command.choice_id,
            commandId: command.command_id,
          });
          return ack(result === "applied" || result === "duplicate", { result });
        }
        case "task.stop": {
          if (!this.core.tasks.get(command.task_id)) {
            return ack(false, { error: `Unknown task: ${command.task_id}` });
          }
          await this.core.tasks.stop(command.task_id);
          return ack(true);
        }
        case "leads.refresh": {
          if (!this.o.leads) {
            return ack(false, {
              error: "No lead engine is set up. Start malves with --leads <signalstack URL>.",
            });
          }
          const leads = await this.o.leads.fetch();
          // Every phone gets them, not just the one that asked.
          for (const s of this.sessions) s.send({ type: "leads", leads, fetched_at: Date.now() });
          return ack(true, { result: String(leads.length) });
        }
        case "tasks.stop_all":
          await this.core.tasks.stopAll();
          return ack(true);
        case "agents.check":
          // The new states reach every phone through `subscribeAgents`.
          await this.o.agents.checkAll();
          return ack(true);
      }
    } catch (error) {
      return ack(false, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Drops connections that stopped answering pings (a phone that lost signal). */
  private ping(): void {
    for (const ws of this.wss?.clients ?? []) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }
}

/** One phone's connection, after a successful handshake. */
class Session {
  private readonly unsubscribe: () => void;
  private readonly unsubscribeAgents: () => void;
  private readonly wish: ReadonlySet<string> | undefined;

  constructor(
    private readonly ws: WebSocket,
    device: Device,
    private readonly key: string,
    hello: Hello,
    core: Core,
    private readonly server: LinkServer,
  ) {
    this.wish = hello.wish ? new Set(hello.wish) : undefined;
    this.send(server.welcome(device));

    // Backlog, then live. Both run in this one tick, so nothing falls in between.
    let after = hello.since_seq;
    for (;;) {
      const page = core.log.since(after, PAGE);
      for (const event of page) this.forward(event);
      const last = page.at(-1);
      if (!last || page.length < PAGE) break;
      after = last.seq;
    }
    this.unsubscribe = core.log.subscribe((event) => {
      if (event.type === "device.revoked" && event.data.device_id === device.id) {
        ws.close(CLOSE.REVOKED, "This phone was revoked on the computer");
        return;
      }
      this.forward(event);
    });
    this.unsubscribeAgents = server.subscribeAgents((agents) =>
      this.send({ type: "agents", agents }),
    );
  }

  receive(frame: unknown): void {
    const command = this.server.open(frame, this.key);
    if (!command) {
      this.ws.close(CLOSE.BAD_MESSAGE, "Unreadable command");
      return;
    }
    void this.server.execute(command).then((ack) => this.send(ack));
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeAgents();
  }

  private forward(event: LoggedEvent): void {
    // Device events stay on the desktop; the Wish List narrows the rest.
    if (event.type.startsWith("device.")) return;
    if (this.wish && !this.wish.has(event.type)) return;
    this.send({ type: "event", event });
  }

  send(message: RunnerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(this.server.seal(message, this.key));
  }
}

function parseJson(raw: RawData): unknown {
  try {
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : Buffer.from(raw).toString("utf8");
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
