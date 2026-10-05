import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { type Core, type OpenQuestion, samePath } from "@malves/core";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

/** The port malves' IDE extension connects to (fixed: the extension can't discover it). */
export const IDE_PORT = 7721;

/** One open IDE window, as the phone sees it. */
export type IdeWindow = {
  id: string;
  /** e.g. "Visual Studio Code", "Cursor", "Antigravity". */
  app: string;
  /** Its open project folders. */
  folders: string[];
};

const HELLO_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 15_000;
const PING_MS = 20_000;

type Window = IdeWindow & { ws: WebSocket };

/**
 * The connection to malves' IDE extension (VS Code, Cursor, Antigravity,
 * Windsurf — all VS Code forks). Only on this computer, only with the secret
 * token from the malves data folder, and never from a web page: browsers always
 * send an Origin header, the extension host never does.
 *
 * Through it the phone can start the IDE's own agent, open a task's changes,
 * and reopen a conversation in the IDE's terminal; and agent questions also
 * show up in the IDE, where they can be answered at the desk.
 */
export class IdeBridge {
  private wss: WebSocketServer | undefined;
  private ping: NodeJS.Timeout | undefined;
  private readonly windows = new Map<string, Window>();
  private readonly pending = new Map<
    string,
    { resolve: (message: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly listeners = new Set<(windows: IdeWindow[]) => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: Core,
    private readonly o: { token: string; port?: number; agentLabel?: (agent: string) => string },
  ) {
    this.unsubscribe = core.log.subscribe((event) => {
      if (event.type === "question.opened") this.broadcast(this.questionMessage(event.data));
      if (event.type === "question.closed") {
        this.broadcast({ type: "closed", question_id: event.data.question_id });
      }
    });
  }

  async start(): Promise<number> {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.o.port ?? IDE_PORT,
      maxPayload: 256 * 1024,
      // A web page can open a socket to 127.0.0.1, but it always says where it's from.
      verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.origin === undefined,
    });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    wss.on("connection", (ws) => this.accept(ws));
    this.ping = setInterval(() => {
      for (const w of this.windows.values()) w.ws.ping();
    }, PING_MS);
    this.ping.unref();
    return (wss.address() as { port: number }).port;
  }

  list(): IdeWindow[] {
    return [...this.windows.values()].map(({ id, app, folders }) => ({ id, app, folders }));
  }

  onChange(listener: (windows: IdeWindow[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The open windows showing this folder (or one of its parents). */
  showing(folder: string): IdeWindow[] {
    return this.list().filter((w) =>
      w.folders.some((f) => samePath(f, folder) || isInside(folder, f)),
    );
  }

  /** Asks one IDE window to do something; resolves with what happened, in plain words. */
  call(windowId: string, op: string, args: Record<string, unknown>): Promise<string> {
    const window = this.windows.get(windowId);
    if (!window) return Promise.reject(new Error("That IDE window isn't open any more."));
    const id = randomBytes(8).toString("base64url");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The IDE didn't answer in time."));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      window.ws.send(JSON.stringify({ type: "call", id, op, args }));
    });
  }

  async close(): Promise<void> {
    clearInterval(this.ping);
    this.unsubscribe();
    for (const w of this.windows.values()) w.ws.terminate();
    const wss = this.wss;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private accept(ws: WebSocket): void {
    let window: Window | undefined;
    const hello = setTimeout(() => ws.close(4001, "No hello"), HELLO_TIMEOUT_MS);
    ws.on("message", (raw: RawData) => {
      const message = parse(raw);
      if (!message) return;
      if (!window) {
        clearTimeout(hello);
        if (message.type !== "hello" || !this.tokenOk(message.token)) {
          ws.close(4001, "Wrong code");
          return;
        }
        window = {
          id: randomBytes(6).toString("base64url"),
          app: text(message.app, 60) || "IDE",
          folders: folders(message.folders),
          ws,
        };
        this.windows.set(window.id, window);
        ws.send(JSON.stringify({ type: "ready" }));
        // Questions already waiting show up in the IDE too.
        for (const q of this.core.questions.pending())
          ws.send(JSON.stringify(this.questionMessage(q)));
        this.changed();
        return;
      }
      this.receive(window, message);
    });
    ws.on("close", () => {
      clearTimeout(hello);
      if (window && this.windows.delete(window.id)) this.changed();
    });
    ws.on("error", () => {});
  }

  private receive(window: Window, message: Record<string, unknown>): void {
    switch (message.type) {
      case "folders":
        window.folders = folders(message.folders);
        this.changed();
        break;
      case "result": {
        const waiting = this.pending.get(String(message.id));
        if (!waiting) break;
        this.pending.delete(String(message.id));
        clearTimeout(waiting.timer);
        if (message.ok === true) waiting.resolve(text(message.message, 500));
        else waiting.reject(new Error(text(message.message, 500) || "The IDE couldn't do that."));
        break;
      }
      case "answer": {
        // Answering at the desk: the same rules as from the phone (first answer wins).
        this.core.questions.answer({
          questionId: text(message.question_id, 64),
          choiceId: text(message.choice_id, 200),
          commandId: `ide-${randomBytes(6).toString("base64url")}`,
        });
        break;
      }
    }
  }

  private questionMessage(q: OpenQuestion) {
    const task = this.core.tasks.get(q.task_id);
    const agent = task ? (this.o.agentLabel?.(task.agent) ?? task.agent) : "The agent";
    return {
      type: "question",
      question_id: q.question_id,
      agent,
      task: task?.prompt.slice(0, 120) ?? "",
      text: q.text,
      risk: q.risk,
      choices: q.choices,
    };
  }

  private tokenOk(given: unknown): boolean {
    const a = Buffer.from(typeof given === "string" ? given : "");
    const b = Buffer.from(this.o.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const w of this.windows.values()) w.ws.send(data);
  }

  private changed(): void {
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }
}

function parse(raw: RawData): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw.toString()) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function folders(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((f): f is string => typeof f === "string" && path.isAbsolute(f)).slice(0, 20)
    : [];
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
