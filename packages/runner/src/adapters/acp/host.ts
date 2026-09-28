import { type ChildProcess, spawn } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCallbacks,
  AgentEnd,
  AgentHost,
  AgentRun,
  AgentSession,
  Decision,
} from "@malves/core";

/** What the runner adds to one agent run: keys, an auth method, extra MCP servers. */
export type RunExtras = {
  env?: Record<string, string>;
  authMethod?: string;
  mcpServers?: acp.McpServer[];
};

export type AcpHostOptions = {
  /** Progress the agent reports (tool calls), for display only. Not logged. */
  onActivity?: (taskId: string, text: string) => void;
  /** Called before each run to add environment, auth and MCP servers. */
  prepare?: (run: AgentRun) => RunExtras | Promise<RunExtras>;
  /** Called when the run ends, to release anything `prepare` set up. */
  release?: (run: AgentRun) => void;
};

const STDERR_TAIL = 4000;

/**
 * Runs one ACP agent per task over stdio (§2). The agent is started from an
 * argument list — never through a shell — in its own process group, so
 * `cancel()` can kill it and anything it started.
 */
export class AcpHost implements AgentHost {
  private readonly live = new Set<ChildProcess>();

  constructor(private readonly options: AcpHostOptions = {}) {}

  start(run: AgentRun, callbacks: AgentCallbacks): AgentSession {
    let stopped = false;
    let child: ChildProcess | undefined;
    const finished = (async () => {
      const extras = (await this.options.prepare?.(run)) ?? {};
      if (stopped) return "cancelled" as const;
      child = this.spawn(run, extras);
      return this.supervise(run, callbacks, child, extras, () => stopped);
    })().finally(() => {
      this.options.release?.(run);
      void stop();
    });

    const stop = async () => {
      stopped = true;
      if (!child) return;
      const c = child;
      kill(c);
      await Promise.race([exitOf(c), delay(3000)]);
      this.live.delete(c);
    };

    return { finished, cancel: stop };
  }

  /** Kills every agent still running. For process exit. */
  killAll(): void {
    for (const child of this.live) kill(child);
  }

  private spawn(run: AgentRun, extras: RunExtras): ChildProcess {
    const child = spawn(run.command.program, [...run.command.args], {
      cwd: run.workspaceRoot,
      env: { ...process.env, ...extras.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.live.add(child);
    return child;
  }

  private supervise(
    run: AgentRun,
    callbacks: AgentCallbacks,
    child: ChildProcess,
    extras: RunExtras,
    isStopped: () => boolean,
  ): Promise<AgentEnd> {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    const ended = new Promise<never>((_, reject) => {
      child.once("error", (error) =>
        reject(new Error(`Could not start the agent: ${error.message}`)),
      );
      child.once("exit", (code, signal) => {
        if (isStopped()) return;
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(
          new Error(`The agent exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`),
        );
      });
    });
    ended.catch(() => {});
    return Promise.race([this.converse(run, callbacks, child, extras, isStopped), ended]);
  }

  private converse(
    run: AgentRun,
    callbacks: AgentCallbacks,
    child: ChildProcess,
    extras: RunExtras,
    isStopped: () => boolean,
  ): Promise<AgentEnd> {
    if (!child.stdin || !child.stdout) throw new Error("agent stdio is not piped");
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    // Anything the agent asks for after the task has stopped is refused.
    const refuseIfStopped = () => {
      if (isStopped()) throw new Error("The task has been stopped");
    };
    const inWorkspace = async (requested: string) => realConfine(callbacks, requested);

    return acp
      .client({ name: "malves" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        if (isStopped()) return { outcome: { outcome: "cancelled" } };
        const choice = await callbacks.decide(permissionDecision(params));
        if (choice === null || isStopped()) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: choice } };
      })
      .onRequest(acp.methods.client.elicitation.create, async ({ params }) => {
        if (isStopped()) return { action: "cancel" };
        const question = choiceQuestion(params);
        if (!question) return { action: "decline" };
        const choice = await callbacks.decide(question.decision);
        if (choice === null || isStopped()) return { action: "cancel" };
        return { action: "accept", content: { [question.field]: question.value(choice) } };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
        refuseIfStopped();
        const content = await readFile(await inWorkspace(params.path), "utf8");
        return { content: sliceLines(content, params.line, params.limit) };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        refuseIfStopped();
        const file = await inWorkspace(params.path);
        refuseIfStopped();
        await writeFile(file, params.content, "utf8");
        return {};
      })
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            elicitation: { form: {} },
          },
        });
        const method = extras.authMethod;
        if (method && init.authMethods?.some((m) => m.id === method)) {
          await ctx.request(acp.methods.agent.authenticate, { methodId: method });
        }
        const request = { cwd: run.workspaceRoot, mcpServers: extras.mcpServers ?? [] };
        return ctx.buildSession(request).withSession(async (session) => {
          const turn = session.prompt(run.prompt);
          const failed = turn.then(() => new Promise<never>(() => {}));
          for (;;) {
            const message = await Promise.race([session.nextUpdate(), failed]);
            if (message.kind === "stop") return agentEnd(message.stopReason);
            const update = message.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              callbacks.output(update.content.text);
            } else if (update.sessionUpdate === "tool_call") {
              this.options.onActivity?.(run.taskId, update.title);
            }
          }
        });
      });
  }
}

function permissionDecision(params: acp.RequestPermissionRequest): Decision {
  const call = params.toolCall;
  const where = (call.locations ?? []).map((l) => l.path).join(", ");
  const title = call.title ?? "The agent wants to use a tool";
  return {
    kind: "permission",
    text: where ? `${title}\n${where}` : title,
    choices: params.options.map((o) => ({ id: o.optionId, label: o.name })),
    risk: riskOf(call.kind ?? undefined),
  };
}

/**
 * An agent's question, if it can be answered by tapping a choice: a form with
 * one single-select or yes/no field. Anything needing typed input is declined
 * for now (the phone has buttons, not a keyboard, in v1).
 */
function choiceQuestion(
  params: acp.CreateElicitationRequest,
):
  | { decision: Decision; field: string; value: (choiceId: string) => string | boolean }
  | undefined {
  if (params.mode !== "form" || !("requestedSchema" in params)) return undefined;
  const schema0 = params.requestedSchema as acp.ElicitationSchema;
  const fields = Object.entries(schema0.properties ?? {});
  if (fields.length !== 1) return undefined;
  const [field, schema] = fields[0] as [string, acp.ElicitationPropertySchema];
  const text = [params.message, schema.title, schema.description].filter(Boolean).join("\n");

  if (schema.type === "boolean") {
    return {
      decision: {
        kind: "agent_question",
        text,
        choices: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
        risk: "medium",
      },
      field,
      value: (id) => id === "yes",
    };
  }
  if (schema.type === "string") {
    const s = schema as {
      enum?: string[] | null;
      oneOf?: Array<{ const: string; title: string }> | null;
    };
    const options =
      s.oneOf?.map((o) => ({ id: o.const, label: o.title })) ??
      s.enum?.map((v) => ({ id: v, label: v }));
    if (!options || options.length === 0) return undefined;
    return {
      decision: { kind: "agent_question", text, choices: options, risk: "medium" },
      field,
      value: (id) => id,
    };
  }
  return undefined;
}

function riskOf(kind: acp.ToolKind | undefined): Decision["risk"] {
  switch (kind) {
    case "read":
    case "search":
    case "think":
      return "low";
    case "edit":
    case "delete":
    case "move":
    case "execute":
      return "high";
    default:
      return "medium";
  }
}

function agentEnd(reason: acp.StopReason): AgentEnd {
  switch (reason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "refused";
    case "max_tokens":
    case "max_turn_requests":
      return "limit_reached";
    default:
      throw new Error(`Unknown stop reason from the agent: ${String(reason)}`);
  }
}

/**
 * The core's confinement is path arithmetic only. Here symlinks are resolved
 * too, so a link inside the workspace can't point the agent outside it.
 */
async function realConfine(callbacks: AgentCallbacks, requested: string): Promise<string> {
  const lexical = callbacks.confine(requested);
  let existing = lexical;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      return callbacks.confine(path.join(real, ...rest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  return lines.slice(start, limit == null ? undefined : start + limit).join("\n");
}

/** Kills the agent and everything it started. SIGKILL: a stopped agent gets no last actions (R3). */
function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function exitOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
