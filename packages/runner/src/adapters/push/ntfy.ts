import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Core, Notifier, OpenQuestion } from "@malves/core";
import { type WebSocket, WebSocketServer } from "ws";

export const PUSH_PORT = 7719;

/**
 * Notifications through the ntfy phone app (R1, R2), with malves itself as the
 * ntfy server — so nothing goes through ntfy.sh or Google. The phone's ntfy app
 * holds a connection to this server over Tailscale and shows each question with
 * up to three answer buttons; a button sends a one-time answer link back here.
 *
 * Push is only a hint (§4): a lost notification breaks nothing, the app still
 * shows the question. Only ever serve this on the Tailscale address — ntfy
 * messages are plain JSON, so on a shared Wi-Fi anyone could read them.
 */
export type NtfyOptions = {
  /** The Tailscale address. */
  host: string;
  /** 0 picks a free port (tests). */
  port?: number;
  /** The secret topic the phone subscribes to. */
  topic: string;
  keepaliveMs?: number;
};

/** One answer button: which question and choice it answers. Single use. */
type AnswerLink = { questionId: string; choiceId: string };

/** ntfy allows three buttons per notification. */
const MAX_BUTTONS = 3;
const KIND_TITLE: Record<OpenQuestion["kind"], string> = {
  agent_question: "An agent has a question",
  permission: "An agent asks permission",
  browser_action: "Allow this in Chrome?",
  budget_floor: "Budget limit reached",
  commit_approval: "Approve this commit?",
};

export class NtfyPush implements Notifier {
  private server: Server | undefined;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly streams = new Set<ServerResponse | WebSocket>();
  private readonly links = new Map<string, AnswerLink>();
  private keepalive: NodeJS.Timeout | undefined;
  private topic: string;
  private base = "";
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: Core,
    private readonly o: NtfyOptions,
  ) {
    this.topic = o.topic;
    this.unsubscribe = core.log.subscribe((event) => {
      // Answered on the app, or timed out: take the notification off the phone.
      if (event.type === "question.closed") this.forget(event.data.question_id);
    });
  }

  /** Starts listening. Resolves with the URL the ntfy app subscribes to. */
  async start(): Promise<string> {
    const server = createServer((req, res) => this.handle(req, res));
    server.on("upgrade", (req, socket, head) => {
      if (!this.isOurs(req, "ws")) return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this.opened(ws, req));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.port ?? PUSH_PORT, this.o.host, resolve);
    });
    const { port } = server.address() as AddressInfo;
    this.base = `http://${this.o.host}:${port}`;
    this.keepalive = setInterval(
      () => this.broadcast(this.event("keepalive")),
      this.o.keepaliveMs ?? 30_000,
    );
    this.keepalive.unref();
    return this.subscribeUrl;
  }

  /** e.g. http://100.101.102.103:7719/<topic> */
  get subscribeUrl(): string {
    return `${this.base}/${this.topic}`;
  }

  /** Opens the ntfy app on the phone straight to "subscribe to this". */
  get subscribeLink(): string {
    const { host } = new URL(this.base);
    return `ntfy://${host}/${this.topic}?secure=false&display=malves`;
  }

  /**
   * A new secret topic: every phone subscribed to the old one is cut off, and
   * every answer button already sent stops working. Used when a phone is revoked.
   */
  renew(topic: string): void {
    this.topic = topic;
    this.links.clear();
    for (const stream of this.streams) end(stream);
    this.streams.clear();
  }

  async questionOpened(question: OpenQuestion): Promise<void> {
    this.broadcast(this.messageFor(question));
  }

  /** A plain notification with no buttons, e.g. the weekly leads digest. Phones not connected now miss it. */
  notify(title: string, message: string): void {
    this.broadcast({ ...this.event("message"), title, message, priority: 3 });
  }

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    this.unsubscribe();
    for (const stream of this.streams) end(stream);
    this.wss.close();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const answer = url.pathname.match(/^\/answer\/([\w-]{20,64})$/);
    if (answer?.[1] && req.method === "POST") return this.answer(answer[1], res);
    if (req.method !== "GET") return reply(res, 405, "Not allowed");
    // The app checks it may read the topic before subscribing.
    if (this.isOurs(req, "auth")) return reply(res, 200, JSON.stringify({ success: true }));
    if (!this.isOurs(req, "json")) return reply(res, 404, "Not found");

    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
    if (url.searchParams.get("poll") === "1") {
      for (const q of this.core.questions.pending()) res.write(line(this.messageFor(q)));
      res.end();
      return;
    }
    this.opened(res, req);
  }

  /** A phone subscribed: say hello, then catch it up on questions still open. */
  private opened(stream: ServerResponse | WebSocket, req: IncomingMessage): void {
    this.streams.add(stream);
    const gone = () => this.streams.delete(stream);
    if ("terminate" in stream) stream.on("close", gone);
    else req.on("close", gone);
    send(stream, this.event("open"));
    for (const q of this.core.questions.pending()) send(stream, this.messageFor(q));
  }

  private answer(token: string, res: ServerResponse) {
    const link = this.links.get(token);
    if (!link) return reply(res, 410, "This answer link has expired.");
    const result = this.core.questions.answer({
      questionId: link.questionId,
      choiceId: link.choiceId,
      commandId: `push-${token}`,
    });
    if (result === "applied" || result === "duplicate") return reply(res, 200, "Done.");
    return reply(res, 410, "Too late: this question already closed.");
  }

  /** `/<topic>/json`, `/<topic>/ws`, `/<topic>/auth`. The app may ask for several topics at once. */
  private isOurs(req: IncomingMessage, kind: "json" | "ws" | "auth"): boolean {
    const path = new URL(req.url ?? "/", "http://x").pathname.split("/");
    return path.length === 3 && path[2] === kind && (path[1] ?? "").split(",").includes(this.topic);
  }

  private messageFor(q: OpenQuestion) {
    const buttons = q.choices.slice(0, MAX_BUTTONS).map((choice, i) => ({
      id: `a${i}`,
      action: "http",
      label: choice.label.slice(0, 40),
      url: `${this.base}/answer/${this.linkFor(q.question_id, choice.id)}`,
      method: "POST",
      clear: true,
    }));
    const more = q.choices.length > MAX_BUTTONS ? "\n\nMore choices in the malves app." : "";
    return {
      ...this.event("message"),
      id: q.question_id,
      // Lets a later `message_delete` take this notification off the phone.
      sequence_id: q.question_id,
      title: `${KIND_TITLE[q.kind]} · ${q.risk} risk`,
      message: `${q.text.slice(0, 2000)}${more}`,
      priority: q.risk === "high" ? 5 : 4,
      actions: buttons,
    };
  }

  /** The same question always gets the same buttons, so a resent notification still works. */
  private linkFor(questionId: string, choiceId: string): string {
    for (const [token, link] of this.links) {
      if (link.questionId === questionId && link.choiceId === choiceId) return token;
    }
    const token = randomBytes(24).toString("base64url");
    this.links.set(token, { questionId, choiceId });
    return token;
  }

  private forget(questionId: string): void {
    for (const [token, link] of this.links) {
      if (link.questionId === questionId) this.links.delete(token);
    }
    this.broadcast({ ...this.event("message_delete"), sequence_id: questionId });
  }

  private event(event: string) {
    return {
      id: randomBytes(9).toString("base64url"),
      time: Math.floor(Date.now() / 1000),
      event,
      topic: this.topic,
    };
  }

  private broadcast(message: object): void {
    for (const stream of this.streams) send(stream, message);
  }
}

function line(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

function send(stream: ServerResponse | WebSocket, message: object): void {
  if ("terminate" in stream) {
    if (stream.readyState === stream.OPEN) stream.send(JSON.stringify(message));
  } else if (!stream.writableEnded) {
    stream.write(line(message));
  }
}

function end(stream: ServerResponse | WebSocket): void {
  if ("terminate" in stream) stream.terminate();
  else stream.end();
}

function reply(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(body);
}
