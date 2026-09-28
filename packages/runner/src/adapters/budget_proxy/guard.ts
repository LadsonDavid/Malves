import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRun, Core, ModelCheck } from "@malves/core";
import type { RunExtras } from "../acp/host.js";

export type Upstream = { url: string; key?: string };

export type GuardConfig = {
  /** freellmapi (or any OpenAI-compatible gateway) — the free path. */
  free?: Upstream;
  /** The user's own key, offered when the free path runs out or falls below the floor. */
  own?: Upstream;
  /** Anthropic-format pass-through for agents that speak it (§14). Always metered as own key. */
  anthropic?: Upstream;
};

export type BudgetStyle = "openai" | "anthropic";

type Mode = "free" | "own_key";
type Registration = { taskId: string; browser: boolean };
type Escalation = { reason: string; answered?: string };
type Outcome = "retry" | "allow" | "stop";

const TIMEOUT_MS = 120_000;
const MAX_BODY = 8 * 1024 * 1024;

/**
 * The budget guard (§6): an OpenAI-compatible endpoint on 127.0.0.1 that
 * agents are pointed at. For every call it records which model really
 * answered and how many tokens it used. When the free gateway runs out, or
 * answers with a model below the quality floor (or a different one than was
 * asked for), it holds the answer and asks the person — own key, allow that
 * model for this task, or pause — instead of silently downgrading (R8).
 */
export class BudgetGuard {
  private server: Server | undefined;
  private url = "";
  private readonly byToken = new Map<string, Registration>();
  private readonly mode = new Map<string, Mode>();
  private readonly escalating = new Map<string, Promise<Outcome>>();

  constructor(
    private readonly core: () => Core,
    private readonly config: GuardConfig,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) fail(res, 502, `budget guard: ${String(error)}`);
        else res.end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.core().log.subscribe((event) => {
      if (
        event.type === "task.updated" &&
        ["done", "failed", "stopped"].includes(event.data.state)
      ) {
        for (const [token, reg] of this.byToken) {
          if (reg.taskId === event.data.task_id) this.byToken.delete(token);
        }
        this.mode.delete(event.data.task_id);
      }
    });
  }

  close(): void {
    this.server?.close();
  }

  get enabled(): boolean {
    return Boolean(this.config.free || this.config.own || this.config.anthropic);
  }

  /** Environment that points an agent at the guard, with a token only this task holds. */
  extrasFor(run: AgentRun, style: BudgetStyle | undefined): RunExtras {
    if (!style || !this.enabled) return {};
    const token = randomBytes(24).toString("base64url");
    this.byToken.set(token, { taskId: run.taskId, browser: run.browser });
    const base = `${this.url}/t/${token}`;
    if (style === "anthropic") {
      return { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: token } };
    }
    return {
      env: { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_BASE: `${base}/v1`, OPENAI_API_KEY: token },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/t\/([A-Za-z0-9_-]+)\/v1\/(chat\/completions|models|messages)$/.exec(
      (req.url ?? "").split("?")[0] ?? "",
    );
    if (!match) return fail(res, 404, "not found");
    const reg = this.byToken.get(match[1] as string);
    if (!reg) return fail(res, 401, "unknown or expired task token");
    const task = this.core().tasks.get(reg.taskId);
    if (!task || ["done", "failed", "stopped"].includes(task.state)) {
      return fail(res, 403, "this task has ended");
    }

    const route = match[2];
    if (route === "models" && req.method === "GET") return this.models(reg, res);
    if (req.method !== "POST") return fail(res, 405, "method not allowed");
    const raw = await readBody(req);
    if (raw === undefined) return fail(res, 413, "request too large");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(res, 400, "invalid JSON");
    }
    if (route === "messages") return this.anthropic(reg, body, res);
    return this.chat(reg, body, res);
  }

  private upstream(taskId: string): { mode: Mode; up: Upstream } | undefined {
    const chosen = this.mode.get(taskId);
    if (chosen === "own_key" && this.config.own) return { mode: "own_key", up: this.config.own };
    if (this.config.free) return { mode: "free", up: this.config.free };
    if (this.config.own) return { mode: "own_key", up: this.config.own };
    return undefined;
  }

  private async models(reg: Registration, res: ServerResponse): Promise<void> {
    const target = this.upstream(reg.taskId);
    if (!target) return fail(res, 503, "no model gateway is configured");
    const up = await fetch(`${target.up.url}/models`, { headers: auth(target.up) });
    res.writeHead(up.status, { "content-type": "application/json" }).end(await up.text());
  }

  private async chat(
    reg: Registration,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const requested = typeof body.model === "string" ? body.model : undefined;
    const stream = body.stream === true;
    if (stream) {
      body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const target = this.upstream(reg.taskId);
      if (!target) return fail(res, 503, "no model gateway is configured");
      const up = await fetch(`${target.up.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth(target.up) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (target.mode === "free" && (up.status === 429 || up.status === 402)) {
        await up.body?.cancel();
        const outcome = await this.escalate(reg, {
          reason: "The free models have run out for now.",
        });
        if (outcome === "stop") return paused(res);
        continue;
      }
      if (!up.ok) {
        res.writeHead(up.status, {
          "content-type": up.headers.get("content-type") ?? "application/json",
        });
        return void res.end(await up.text());
      }

      if (!stream) {
        const json = (await up.json()) as { model?: string; usage?: Record<string, number> };
        const answered = json.model ?? requested ?? "unknown";
        const verdict = this.checked(reg, target.mode, requested, answered);
        if (!verdict.ok) {
          const outcome = await this.escalate(reg, { reason: verdict.message, answered });
          if (outcome === "stop") return paused(res);
          if (outcome === "retry") continue;
        }
        this.record(reg, target.mode, answered, requested, json.usage);
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(json));
      }

      // Streaming: hold everything until the first chunk says which model is answering.
      const result = await this.relayStream(reg, target.mode, requested, up, res);
      if (result === "sent") return;
      const outcome = await this.escalate(reg, {
        reason: result.message,
        answered: result.answered,
      });
      if (outcome === "stop") return paused(res);
      if (outcome === "allow") this.core().budget.allow(reg.taskId, result.answered);
    }
    fail(res, 503, "gave up after repeated model problems");
  }

  private async relayStream(
    reg: Registration,
    mode: Mode,
    requested: string | undefined,
    up: Response,
    res: ServerResponse,
  ): Promise<"sent" | { message: string; answered: string }> {
    const reader = (up.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const held: Uint8Array[] = [];
    let text = "";
    let answered: string | undefined;
    let usage: Record<string, number> | undefined;

    const scan = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as {
            model?: string;
            usage?: Record<string, number> | null;
          };
          if (!answered && parsed.model) answered = parsed.model;
          if (parsed.usage) usage = parsed.usage;
        } catch {
          // A partial line; the next chunk completes it.
        }
      }
    };

    // Phase 1: hold the stream until the model is known.
    while (!answered) {
      const { done, value } = await reader.read();
      if (done) break;
      held.push(value);
      text += decoder.decode(value, { stream: true });
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      scan(complete);
      text = text.slice(complete.length);
    }
    const model = answered ?? requested ?? "unknown";
    const verdict = this.checked(reg, mode, requested, model);
    if (!verdict.ok) {
      await reader.cancel();
      return { message: verdict.message, answered: model };
    }

    // Phase 2: pass it through, still watching for the usage chunk.
    res.writeHead(200, {
      "content-type": up.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const chunk of held) res.write(chunk);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      text += decoder.decode(value, { stream: true });
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      scan(complete);
      text = text.slice(complete.length);
    }
    res.end();
    this.record(reg, mode, model, requested, usage);
    return "sent";
  }

  private checked(
    reg: Registration,
    mode: Mode,
    requested: string | undefined,
    answered: string,
  ): ModelCheck {
    // With the user's own key they get what they asked for; the floor guards the free path.
    if (mode === "own_key") return { ok: true };
    return this.core().budget.check({
      taskId: reg.taskId,
      browser: reg.browser,
      answered,
      ...(requested ? { requested } : {}),
    });
  }

  /** One question per task at a time; concurrent calls wait for the same answer. */
  private escalate(reg: Registration, problem: Escalation): Promise<Outcome> {
    const running = this.escalating.get(reg.taskId);
    if (running) return running;
    const asking = this.ask(reg, problem).finally(() => this.escalating.delete(reg.taskId));
    this.escalating.set(reg.taskId, asking);
    return asking;
  }

  private async ask(reg: Registration, problem: Escalation): Promise<Outcome> {
    const choices = [];
    if (this.config.own) choices.push({ id: "own_key", label: "Use my own key" });
    if (problem.answered)
      choices.push({ id: "allow", label: `Allow ${clip(problem.answered, 28)}` });
    choices.push({ id: "pause", label: "Pause the task" });
    const choice = await this.core().tasks.ask(reg.taskId, {
      kind: "budget_floor",
      text: `${problem.reason} ${this.config.own ? "Pause, or use your own key?" : "Pause the task?"}`,
      choices,
      risk: "medium",
    });
    if (choice === "own_key") {
      this.mode.set(reg.taskId, "own_key");
      return "retry";
    }
    if (choice === "allow" && problem.answered) {
      this.core().budget.allow(reg.taskId, problem.answered);
      return "allow";
    }
    if (choice === "pause") await this.core().tasks.stop(reg.taskId, `Paused: ${problem.reason}`);
    return "stop";
  }

  private record(
    reg: Registration,
    mode: Mode,
    model: string,
    requested: string | undefined,
    usage: Record<string, number> | undefined,
  ): void {
    this.core().budget.record({
      task_id: reg.taskId,
      model,
      ...(requested ? { requested_model: requested } : {}),
      via: mode,
      input_tokens: Math.max(0, Math.round(usage?.prompt_tokens ?? usage?.input_tokens ?? 0)),
      output_tokens: Math.max(0, Math.round(usage?.completion_tokens ?? usage?.output_tokens ?? 0)),
    });
  }

  /** Anthropic-format pass-through, metered as the user's own key. */
  private async anthropic(
    reg: Registration,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const up = this.config.anthropic;
    if (!up) return fail(res, 503, "no Anthropic-compatible upstream is configured");
    const response = await fetch(`${up.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(up.key ? { "x-api-key": up.key } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const requested = typeof body.model === "string" ? body.model : undefined;
    if (body.stream !== true || !response.ok) {
      const text = await response.text();
      if (response.ok) {
        const json = JSON.parse(text) as { model?: string; usage?: Record<string, number> };
        this.record(reg, "own_key", json.model ?? requested ?? "unknown", requested, json.usage);
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      return void res.end(text);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let model = requested ?? "unknown";
    let input = 0;
    let output = 0;
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      buffer += decoder.decode(value, { stream: true });
      const complete = buffer.slice(0, buffer.lastIndexOf("\n") + 1);
      buffer = buffer.slice(complete.length);
      for (const line of complete.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const e = JSON.parse(line.slice(5)) as {
            message?: { model?: string; usage?: { input_tokens?: number } };
            usage?: { output_tokens?: number };
          };
          if (e.message?.model) model = e.message.model;
          if (e.message?.usage?.input_tokens) input = e.message.usage.input_tokens;
          if (e.usage?.output_tokens) output = e.usage.output_tokens;
        } catch {
          // ignore partial lines
        }
      }
    }
    res.end();
    this.record(reg, "own_key", model, requested, { input_tokens: input, output_tokens: output });
  }
}

function auth(up: Upstream): Record<string, string> {
  return up.key ? { authorization: `Bearer ${up.key}` } : {};
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "malves_budget_guard" } }));
}

function paused(res: ServerResponse): void {
  fail(res, 503, "malves paused this task at the user's request, or because no one answered.");
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
