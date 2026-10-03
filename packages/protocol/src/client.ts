import { type KeyPair, open, randomToken, seal } from "./crypto.js";
import type { LoggedEvent } from "./events.js";
import type { Lead } from "./leads.js";
import {
  type Ack,
  type AgentInfo,
  ChallengeFrame,
  CLOSE,
  type Command,
  FINAL_CLOSE_CODES,
  type Hello,
  LINK_VERSION,
  RunnerMessage,
  SealedFrame,
  type Welcome,
} from "./link.js";

/**
 * The phone's side of the link (§4). Uses the standard WebSocket API, so the
 * same code runs in React Native and in Node tests.
 *
 * - Resumes from the last event it saw, so a dropout loses nothing.
 * - Every command has an id and is re-sent after a reconnect until the runner
 *   acknowledges it; the runner applies each id once.
 * - Reconnects with capped exponential backoff and jitter.
 */

/** The parts of a WebSocket this client uses. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type LinkStatus =
  /** Trying to reach the runner. */
  | "connecting"
  /** Handshake done; events and commands flow. */
  | "online"
  /** Lost the connection; will retry. */
  | "offline"
  /** The runner refused this phone (unpaired, revoked, bad code, version). Won't retry. */
  | "rejected";

export type LinkClientOptions = {
  url: string;
  /** The runner's public key, from the QR code. */
  runnerKey: string;
  /** This phone's key pair. */
  keys: KeyPair;
  /** Only for the very first connection: the code from the QR, and this phone's name. */
  pair?: { code: string; name: string };
  /** Resume after this event. */
  sinceSeq?: number;
  /** Only these event types. */
  wish?: string[];
  onWelcome?: (welcome: Welcome) => void;
  /** Agent readiness changed on the computer. */
  onAgents?: (agents: AgentInfo[]) => void;
  /** Chrome connected or disconnected on the computer. */
  onChrome?: (connected: boolean) => void;
  /** This week's leads arrived (after `refreshLeads`). */
  onLeads?: (leads: Lead[], fetchedAt: number) => void;
  onEvent?: (event: LoggedEvent) => void;
  onStatus?: (status: LinkStatus, detail?: string) => void;
  /** Defaults to the global WebSocket. */
  socket?: (url: string) => SocketLike;
  /** Defaults to the global timers. */
  timers?: Timers;
  maxBackoffMs?: number;
};

type Pending = {
  command: Command;
  resolve: (ack: Ack) => void;
  reject: (error: Error) => void;
};

/** A command without its id; the client assigns one. */
type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, "command_id">
    : never
  : never;

const BASE_BACKOFF_MS = 500;

export class LinkClient {
  private readonly pending = new Map<string, Pending>();
  private readonly timers: Timers;
  private socket: SocketLike | undefined;
  private pair: { code: string; name: string } | undefined;
  private seq: number;
  private online = false;
  private stopped = true;
  private attempt = 0;
  private retry: unknown;

  constructor(private readonly o: LinkClientOptions) {
    this.seq = o.sinceSeq ?? 0;
    this.pair = o.pair;
    this.timers = o.timers ?? (globalThis as unknown as Timers);
  }

  /** The last event received. Persist it to resume after an app restart. */
  get lastSeq(): number {
    return this.seq;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  /** Closes for good. Commands still waiting for an answer are rejected. */
  close(): void {
    this.stopped = true;
    this.timers.clearTimeout(this.retry);
    this.socket?.close(1000);
    this.rejectPending(new Error("The link was closed"));
  }

  /** `resume`: an agent session id from `listSessions`, to continue it. */
  createTask(input: {
    workspaceId: string;
    agent: string;
    prompt: string;
    resume?: string | undefined;
  }): Promise<Ack> {
    return this.send({
      type: "task.create",
      workspace_id: input.workspaceId,
      agent: input.agent,
      prompt: input.prompt,
      ...(input.resume ? { resume: input.resume } : {}),
    });
  }

  /** A finished task's changes as a diff, in `ack.result`. */
  viewChanges(taskId: string): Promise<Ack> {
    return this.send({ type: "changes.diff", task_id: taskId });
  }

  /** Continues a finished task's conversation with the same agent. */
  reply(taskId: string, prompt: string): Promise<Ack> {
    return this.send({ type: "task.reply", task_id: taskId, prompt });
  }

  /** The agent's saved sessions in a project; they come back in `ack.sessions`. */
  listSessions(input: { workspaceId: string; agent: string }): Promise<Ack> {
    return this.send({
      type: "sessions.list",
      workspace_id: input.workspaceId,
      agent: input.agent,
    });
  }

  answer(input: { questionId: string; choiceId: string }): Promise<Ack> {
    return this.send({ type: "answer", question_id: input.questionId, choice_id: input.choiceId });
  }

  stopTask(taskId: string): Promise<Ack> {
    return this.send({ type: "task.stop", task_id: taskId });
  }

  /** Asks the computer to re-check which agents are ready (e.g. after signing in). */
  checkAgents(): Promise<Ack> {
    return this.send({ type: "agents.check" });
  }

  /** Asks the computer for this week's leads; they arrive through `onLeads`. */
  refreshLeads(): Promise<Ack> {
    return this.send({ type: "leads.refresh" });
  }

  private send(input: CommandInput): Promise<Ack> {
    const command = { ...input, command_id: randomToken(12) } as Command;
    return new Promise((resolve, reject) => {
      this.pending.set(command.command_id, { command, resolve, reject });
      if (this.online) this.transmit(command);
    });
  }

  private open(): void {
    this.o.onStatus?.("connecting");
    const socket = (this.o.socket ?? defaultSocket)(this.o.url);
    this.socket = socket;
    let challenge: string | undefined;

    socket.onmessage = ({ data }) => {
      const frame = parseJson(data);
      if (challenge === undefined) {
        const first = ChallengeFrame.safeParse(frame);
        if (!first.success) return socket.close(CLOSE.BAD_MESSAGE, "expected a challenge");
        challenge = first.data.challenge;
        const hello: Hello = {
          type: "hello",
          v: LINK_VERSION,
          challenge,
          since_seq: this.seq,
          ...(this.o.wish ? { wish: this.o.wish } : {}),
          ...(this.pair ? { pair: this.pair } : {}),
        };
        socket.send(
          JSON.stringify({
            device: this.o.keys.publicKey,
            ...seal(hello, this.o.runnerKey, this.o.keys.secretKey),
          }),
        );
        return;
      }
      const sealed = SealedFrame.safeParse(frame);
      const message = sealed.success
        ? RunnerMessage.safeParse(open(sealed.data, this.o.runnerKey, this.o.keys.secretKey))
        : undefined;
      if (!message?.success) return socket.close(CLOSE.BAD_MESSAGE, "unreadable message");
      this.receive(message.data);
    };

    socket.onclose = ({ code, reason }) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.online = false;
      if (this.stopped) return this.o.onStatus?.("offline");
      if (FINAL_CLOSE_CODES.includes(code)) {
        this.stopped = true;
        this.rejectPending(new Error(reason || `Refused by the runner (${code})`));
        return this.o.onStatus?.("rejected", reason);
      }
      this.o.onStatus?.("offline", reason);
      this.scheduleRetry();
    };

    socket.onerror = () => {};
  }

  private receive(message: RunnerMessage): void {
    switch (message.type) {
      case "welcome":
        this.online = true;
        this.attempt = 0;
        this.pair = undefined;
        this.o.onWelcome?.(message);
        this.o.onStatus?.("online");
        for (const { command } of this.pending.values()) this.transmit(command);
        break;
      case "chrome":
        this.o.onChrome?.(message.connected);
        break;
      case "leads":
        this.o.onLeads?.(message.leads, message.fetched_at);
        break;
      case "agents":
        this.o.onAgents?.(message.agents);
        break;
      case "event":
        if (message.event.seq <= this.seq) break;
        this.seq = message.event.seq;
        this.o.onEvent?.(message.event);
        break;
      case "ack": {
        const waiting = this.pending.get(message.command_id);
        this.pending.delete(message.command_id);
        waiting?.resolve(message);
        break;
      }
    }
  }

  private transmit(command: Command): void {
    this.socket?.send(JSON.stringify(seal(command, this.o.runnerKey, this.o.keys.secretKey)));
  }

  private scheduleRetry(): void {
    const max = this.o.maxBackoffMs ?? 30_000;
    const ceiling = Math.min(max, BASE_BACKOFF_MS * 2 ** this.attempt);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.attempt += 1;
    this.retry = this.timers.setTimeout(() => {
      if (!this.stopped) this.open();
    }, delay);
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

function defaultSocket(url: string): SocketLike {
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!WebSocketCtor) throw new Error("No WebSocket available; pass `socket`");
  return new WebSocketCtor(url);
}

function parseJson(data: unknown): unknown {
  try {
    return JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    return undefined;
  }
}
