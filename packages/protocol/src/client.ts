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
  type HandoverState,
  type Hello,
  type IdeInfo,
  LINK_VERSION,
  RunnerMessage,
  type ScreenInput,
  SealedFrame,
  type Speak,
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
  /** IDE windows on the computer changed. */
  onIdes?: (ides: IdeInfo[]) => void;
  /** A running task's agent did something (live only). */
  onActivity?: (taskId: string, text: string, at: number) => void;
  /** Chrome connected or disconnected on the computer. */
  onChrome?: (connected: boolean) => void;
  /** A piece of Malves' spoken reply (natural voice). */
  onAudio?: (piece: {
    commandId: string;
    index: number;
    last: boolean;
    mime: string;
    data: string;
    failed?: string | undefined;
    part: number;
    text?: string | undefined;
    lang?: "ta" | "en" | undefined;
    done: boolean;
    note?: string | undefined;
  }) => void;
  /** Handover mode started or ended. */
  onHandover?: (state: HandoverState) => void;
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
    /** A project id, or a folder from `allSessions`. */
    workspaceId?: string | undefined;
    folder?: string | undefined;
    agent: string;
    prompt: string;
    resume?: string | undefined;
  }): Promise<Ack> {
    return this.send({
      type: "task.create",
      ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
      ...(input.folder ? { folder: input.folder } : {}),
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

  /**
   * Precise dictation: sends a recording (base64 WAV) in pieces, then asks the
   * computer to transcribe it with Whisper. The text is in `ack.result`.
   */
  async transcribe(audioBase64: string, language: string): Promise<Ack> {
    const uploadId = randomToken(12);
    const size = 131_072;
    for (let i = 0, index = 0; i < audioBase64.length; i += size, index++) {
      const ack = await this.send({
        type: "voice.chunk",
        upload_id: uploadId,
        index,
        data: audioBase64.slice(i, i + size),
      });
      if (!ack.ok) return ack;
    }
    return this.send({ type: "voice.transcribe", upload_id: uploadId, language });
  }

  /** Says something to Malves; the reply is in `ack.assistant`. */
  assistantSay(
    conversationId: string,
    text: string,
    alternatives: string[] = [],
    speak: Speak = false,
    commandId?: string,
    where?: string,
  ): Promise<Ack> {
    return this.send(
      {
        type: "assistant.say",
        conversation_id: conversationId,
        text,
        ...(alternatives.length ? { alternatives: alternatives.slice(0, 5) } : {}),
        ...(speak ? { speak } : {}),
        ...(where ? { where: where.slice(0, 500) } : {}),
      },
      commandId,
    );
  }

  /** Shows Malves a photo (JPEG, base64) and asks about it; the answer is in `ack.assistant`. */
  async assistantLook(
    conversationId: string,
    jpegBase64: string,
    question = "",
    speak: Speak = false,
    commandId?: string,
  ): Promise<Ack> {
    const uploadId = randomToken(12);
    const size = 131_072;
    for (let i = 0, index = 0; i < jpegBase64.length; i += size, index++) {
      const ack = await this.send({
        type: "image.chunk",
        upload_id: uploadId,
        index,
        data: jpegBase64.slice(i, i + size),
      });
      if (!ack.ok) return ack;
    }
    return this.send(
      {
        type: "assistant.look",
        conversation_id: conversationId,
        upload_id: uploadId,
        ...(question ? { question } : {}),
        ...(speak ? { speak } : {}),
      },
      commandId,
    );
  }

  /** Yes or no to the action Malves read back. */
  assistantConfirm(
    conversationId: string,
    pendingId: string,
    yes: boolean,
    speak: Speak = false,
    commandId?: string,
  ): Promise<Ack> {
    return this.send(
      {
        type: "assistant.confirm",
        conversation_id: conversationId,
        pending_id: pendingId,
        yes,
        ...(speak ? { speak } : {}),
      },
      commandId,
    );
  }

  /** What Malves remembers, in `ack.memories`. */
  memoryList(): Promise<Ack> {
    return this.send({ type: "memory.list" });
  }

  /** Deletes one memory for good. */
  memoryForget(memoryId: string): Promise<Ack> {
    return this.send({ type: "memory.forget", memory_id: memoryId });
  }

  /** Asks an open IDE's own agent to do something; `ack.result` says what happened. */
  ideAgent(ideId: string, prompt: string): Promise<Ack> {
    return this.send({ type: "ide.agent", ide_id: ideId, prompt });
  }

  /** Opens a finished task's changes in an open IDE. */
  ideOpenChanges(ideId: string, taskId: string): Promise<Ack> {
    return this.send({ type: "ide.open_changes", ide_id: ideId, task_id: taskId });
  }

  /** Reopens an agent conversation in the IDE's terminal. */
  ideResume(input: {
    ideId: string;
    workspaceId: string;
    agent: string;
    sessionId: string;
  }): Promise<Ack> {
    return this.send({
      type: "ide.resume",
      ide_id: input.ideId,
      workspace_id: input.workspaceId,
      agent: input.agent,
      session_id: input.sessionId,
    });
  }

  /** One picture of the computer's screen; it's in `ack.frame`. */
  screenFrame(): Promise<Ack> {
    return this.send({ type: "screen.frame" });
  }

  /** Lets Malves ring this phone (its Firebase token). */
  registerCalls(token: string): Promise<Ack> {
    return this.send({ type: "call.register", token });
  }

  /** You answered Malves' call; what it says first is in `ack.result`. */
  answerCall(callId: string, speak: Speak = false, commandId?: string): Promise<Ack> {
    return this.send(
      { type: "call.answer", call_id: callId, ...(speak ? { speak } : {}) },
      commandId,
    );
  }

  declineCall(callId: string): Promise<Ack> {
    return this.send({ type: "call.decline", call_id: callId });
  }

  /** Says `text` in Malves' natural voice; the audio arrives as `assistant.audio`. */
  speakText(text: string, speak: Speak, commandId?: string): Promise<Ack> {
    return this.send({ type: "voice.speak", text: text.slice(0, 2000), speak }, commandId);
  }

  /** Malves rings this phone now, to check calls work. */
  testCall(): Promise<Ack> {
    return this.send({ type: "call.test" });
  }

  /** Starts live video of the screen; the computer's answer is in `ack.video`. */
  screenVideo(sdp: string): Promise<Ack> {
    return this.send({ type: "screen.video", sdp });
  }

  screenVideoStop(): Promise<Ack> {
    return this.send({ type: "screen.video.stop" });
  }

  /** A click, scroll, typing or keys on the computer, from you. */
  screenInput(input: Omit<ScreenInput, "type" | "command_id">): Promise<Ack> {
    return this.send({ type: "screen.input", ...input });
  }

  /** Every session on the computer (Claude Code, Codex, Cursor, Antigravity) and their folders. */
  allSessions(tool?: "claude" | "codex" | "cursor" | "antigravity"): Promise<Ack> {
    return this.send({ type: "sessions.all", ...(tool ? { tool } : {}) });
  }

  /** One session's conversation; it's in `ack.messages`. */
  readSession(
    tool: "claude" | "codex" | "cursor" | "antigravity",
    sessionId: string,
  ): Promise<Ack> {
    return this.send({ type: "session.read", tool, session_id: sessionId });
  }

  /** Continues a session; a new task's id is in `ack.task_id`, what happened in `ack.result`. */
  continueSession(
    tool: "claude" | "codex" | "cursor" | "antigravity",
    sessionId: string,
    text: string,
  ): Promise<Ack> {
    return this.send({ type: "session.continue", tool, session_id: sessionId, text });
  }

  /** Takes the computer back from Malves (ends handover mode). */
  stopHandover(): Promise<Ack> {
    return this.send({ type: "handover.stop" });
  }

  /** Stops every running task on the computer. */
  stopAll(): Promise<Ack> {
    return this.send({ type: "tasks.stop_all" });
  }

  /** Asks the computer to re-check which agents are ready (e.g. after signing in). */
  checkAgents(): Promise<Ack> {
    return this.send({ type: "agents.check" });
  }

  /** Asks the computer for this week's leads; they arrive through `onLeads`. */
  refreshLeads(): Promise<Ack> {
    return this.send({ type: "leads.refresh" });
  }

  private send(input: CommandInput, commandId = randomToken(12)): Promise<Ack> {
    const command = { ...input, command_id: commandId } as Command;
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
      const opened = sealed.success
        ? open(sealed.data, this.o.runnerKey, this.o.keys.secretKey)
        : undefined;
      // Not sealed by our computer: something is wrong with the link itself.
      if (opened === undefined) return socket.close(CLOSE.BAD_MESSAGE, "unreadable message");
      const message = RunnerMessage.safeParse(opened);
      // Sealed by our computer but a kind this app doesn't know (a newer runner): skip it.
      // Closing would reconnect and get the same message again, forever.
      if (message.success) this.receive(message.data);
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
      case "activity":
        this.o.onActivity?.(message.task_id, message.text, message.at);
        break;
      case "ides":
        this.o.onIdes?.(message.ides);
        break;
      case "chrome":
        this.o.onChrome?.(message.connected);
        break;
      case "handover":
        this.o.onHandover?.(message.state);
        break;
      case "assistant.audio":
        this.o.onAudio?.({
          commandId: message.command_id,
          index: message.index,
          last: message.last,
          mime: message.mime,
          data: message.data,
          failed: message.failed,
          part: message.part ?? 0,
          text: message.text,
          lang: message.lang,
          done: message.done === true,
          note: message.note,
        });
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
