import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Core } from "@malves/core";
import { TERMINAL_STATES } from "@malves/protocol";

/**
 * The budget guard (§6, R8): a local endpoint between a metered agent and
 * freellmapi (your own free-tier keys). It
 *  1. records which model answered each task, and logs every switch;
 *  2. enforces an optional quality floor — a model you didn't allow is held
 *     back and you are asked first, never silently used;
 *  3. stops the task plainly when the free quota is used up.
 *
 * Each task gets its own URL, so usage is counted per task and a finished
 * task's URL stops working. The freellmapi key stays here: the agent never
 * sees it.
 */
export type GuardOptions = {
  /** freellmapi's origin, e.g. http://127.0.0.1:3001 */
  upstream: string;
  /** freellmapi's unified key. */
  key: string;
  /** Models allowed without asking: case-insensitive parts of "platform/model". Empty: any. */
  allow?: string[];
  /** 0 picks a free port. */
  port?: number;
};

type Usage = { model?: string; calls: number; input: number; output: number; allowed: Set<string> };

const MAX_BODY_BYTES = 20 * 1024 * 1024;
/** Request headers never passed on: our own auth replaces the agent's placeholder. */
const DROP = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "x-api-key",
  "accept-encoding",
  "transfer-encoding",
]);

export class BudgetGuard {
  private server: Server | undefined;
  private base = "";
  /** URL token → task id. */
  private readonly tokens = new Map<string, string>();
  private readonly usage = new Map<string, Usage>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly core: Core,
    private readonly o: GuardOptions,
  ) {
    this.unsubscribe = core.log.subscribe((event) => {
      if (event.type === "task.updated" && TERMINAL_STATES.includes(event.data.state)) {
        this.finish(event.data.task_id);
      }
    });
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`malves budget guard: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.port ?? 0, "127.0.0.1", resolve);
    });
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** The base URL one task's agent talks to (Anthropic clients add `/v1/messages`). */
  urlFor(taskId: string): string {
    const token = randomBytes(18).toString("base64url");
    this.tokens.set(token, taskId);
    return `${this.base}/t/${token}`;
  }

  async close(): Promise<void> {
    this.unsubscribe();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = (req.url ?? "").match(/^\/t\/([\w-]+)(\/.*)$/);
    const taskId = match?.[1] ? this.tokens.get(match[1]) : undefined;
    if (!match?.[2] || !taskId) return void res.writeHead(403).end("Unknown task");
    const body = await readBody(req);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.o.key}`,
      "accept-encoding": "identity",
      "x-freellm-task-type": "code",
    };
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROP.has(name) && typeof value === "string") headers[name] = value;
    }
    const usage = this.usageOf(taskId);

    // A model below the floor is held back while the user decides; then try again.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.isActive(taskId)) return void res.writeHead(409).end("The task has stopped");
      const upstream = await fetch(new URL(match[2], this.o.upstream), {
        method: req.method ?? "POST",
        headers,
        ...(body.length > 0 ? { body } : {}),
      });
      const model = decodeURIComponent(upstream.headers.get("x-routed-via") ?? "");

      if (upstream.status === 429) {
        const until = upstream.headers.get("retry-after");
        void this.core.tasks.stop(
          taskId,
          `The free models are used up for now${until ? ` (try again in ${until} s)` : ""}. Add more keys in freellmapi, or run this with Claude on your subscription.`,
        );
        return relay(upstream, res, () => {});
      }
      if (model && upstream.ok && !this.allowed(model, usage)) {
        await upstream.body?.cancel();
        const choice = await this.core.tasks.ask(taskId, {
          kind: "budget_floor",
          text: `The only free model available right now is ${model}, which is below your quality floor. Use it for this task?`,
          choices: [
            { id: "allow", label: "Use it" },
            { id: "stop", label: "Stop the task" },
          ],
          risk: "medium",
        });
        if (choice !== "allow") {
          if (choice === "stop") {
            void this.core.tasks.stop(
              taskId,
              "Stopped: only models below your quality floor were free.",
            );
          }
          return void res.writeHead(503).end("Stopped by the budget guard");
        }
        usage.allowed.add(model);
        continue;
      }

      if (model && model !== usage.model) {
        usage.model = model;
        this.core.log.append({ type: "task.model", data: { task_id: taskId, model } });
      }
      return relay(upstream, res, (text, json) => {
        const [input, output] = tokensIn(text, json);
        usage.calls += 1;
        usage.input += input;
        usage.output += output;
      });
    }
    res.writeHead(503).end("No allowed model answered");
  }

  private allowed(model: string, usage: Usage): boolean {
    const allow = this.o.allow ?? [];
    const name = model.toLowerCase();
    return allow.length === 0 || usage.allowed.has(model) || allow.some((a) => name.includes(a));
  }

  private usageOf(taskId: string): Usage {
    let usage = this.usage.get(taskId);
    if (!usage) {
      usage = { calls: 0, input: 0, output: 0, allowed: new Set() };
      this.usage.set(taskId, usage);
    }
    return usage;
  }

  private isActive(taskId: string): boolean {
    const task = this.core.tasks.get(taskId);
    return task !== undefined && !TERMINAL_STATES.includes(task.state);
  }

  /** A finished task's URL stops working, and its usage is logged once. */
  private finish(taskId: string): void {
    for (const [token, id] of this.tokens) if (id === taskId) this.tokens.delete(token);
    const usage = this.usage.get(taskId);
    this.usage.delete(taskId);
    if (!usage || usage.calls === 0) return;
    this.core.log.append({
      type: "task.usage",
      data: {
        task_id: taskId,
        calls: usage.calls,
        input_tokens: usage.input,
        output_tokens: usage.output,
      },
    });
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Streams the answer to the agent as it arrives, then hands the whole text over for counting. */
async function relay(
  upstream: Response,
  res: ServerResponse,
  done: (text: string, json: boolean) => void,
): Promise<void> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (name !== "content-encoding" && name !== "content-length" && name !== "transfer-encoding") {
      headers[name] = value;
    }
  });
  res.writeHead(upstream.status, headers);
  let text = "";
  if (upstream.body) {
    for await (const chunk of Readable.fromWeb(upstream.body as never)) {
      res.write(chunk);
      // ponytail: keeps the whole answer to count tokens; fine for chat-sized replies.
      text += Buffer.from(chunk as Uint8Array).toString("utf8");
    }
  }
  res.end();
  done(text, (upstream.headers.get("content-type") ?? "").includes("json"));
}

/**
 * Input and output tokens from one answer, whatever the format: Anthropic
 * (`input_tokens`/`output_tokens`, streamed in `message_start`/`message_delta`)
 * or OpenAI (`prompt_tokens`/`completion_tokens`). Streams repeat running totals,
 * so the largest value seen is the answer's total.
 */
export function tokensIn(text: string, json: boolean): [number, number] {
  const bodies = json
    ? [text]
    : text.split("\n").flatMap((l) => (l.startsWith("data:") ? [l.slice(5).trim()] : []));
  let input = 0;
  let output = 0;
  for (const raw of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const u of usagesIn(parsed)) {
      input = Math.max(input, num(u.input_tokens) + num(u.prompt_tokens));
      output = Math.max(output, num(u.output_tokens) + num(u.completion_tokens));
    }
  }
  return [input, output];
}

type UsageShape = Record<string, unknown>;

function usagesIn(value: unknown): UsageShape[] {
  if (typeof value !== "object" || value === null) return [];
  const v = value as Record<string, unknown>;
  const nested = [
    v.usage,
    (v.message as UsageShape | undefined)?.usage,
    (v.response as UsageShape | undefined)?.usage,
  ];
  return nested.filter((u): u is UsageShape => typeof u === "object" && u !== null);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The guard, if freellmapi is set up: MALVES_MODELS_URL, MALVES_MODELS_KEY, MALVES_MODELS_ALLOW. */
export function guardFromEnv(core: Core): BudgetGuard | undefined {
  const upstream = process.env.MALVES_MODELS_URL;
  const key = process.env.MALVES_MODELS_KEY;
  if (!upstream || !key) return undefined;
  const allow = (process.env.MALVES_MODELS_ALLOW ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  return new BudgetGuard(core, { upstream, key, allow });
}
