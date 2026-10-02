import { type ChildProcess, spawn } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCallbacks,
  AgentEnd,
  AgentHost,
  AgentRun,
  AgentSession,
  Command,
  Decision,
} from "@malves/core";

export type AcpHostOptions = {
  /** Progress the agent reports (tool calls), for display only. Not logged. */
  onActivity?: (taskId: string, text: string) => void;
  /** The agent refused to start a session until it is signed in. */
  onSignInNeeded?: (agent: string) => void;
  /** The agent opened a session, so it is signed in and working. */
  onReady?: (agent: string) => void;
  /** What to tell the user when an agent needs signing in. */
  signInMessage?: (agent: string) => string;
};

/** Whether an agent can take a task right now. */
export type Probe = { state: "ready" | "needs_sign_in" | "unavailable"; detail?: string };

/** ACP's `auth_required` error code. */
const AUTH_REQUIRED = -32000;

const STDERR_TAIL = 4000;
/** Larger files are refused rather than loaded into memory. */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/**
 * Runs one ACP agent per task over stdio (§2). The agent is started from an
 * argument list — never through a shell — in its own process group, so
 * `cancel()` can kill it and anything it started.
 */
export class AcpHost implements AgentHost {
  private readonly live = new Set<ChildProcess>();

  constructor(private readonly options: AcpHostOptions = {}) {}

  start(run: AgentRun, callbacks: AgentCallbacks): AgentSession {
    const child = spawn(run.command.program, [...run.command.args], {
      cwd: run.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.live.add(child);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });

    let stopped = false;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const ended = new Promise<never>((_, reject) => {
      child.once("error", (error) =>
        reject(new Error(`Could not start the agent: ${error.message}`)),
      );
      child.once("exit", (code, signal) => {
        if (stopped) return;
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(
          new Error(`The agent exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`),
        );
      });
    });
    ended.catch(() => {});

    const stop = async () => {
      stopped = true;
      kill(child);
      await Promise.race([exited, delay(3000)]);
      this.live.delete(child);
    };

    // "Authentication required" means nothing to most people; say what to do.
    const conversation = this.converse(run, callbacks, child, () => stopped).catch(
      (error: unknown) => {
        if (!isAuthRequired(error)) throw error;
        this.options.onSignInNeeded?.(run.agent);
        throw new Error(
          this.options.signInMessage?.(run.agent) ??
            `${run.agent} isn't signed in on this computer. Sign in there, then try again.`,
        );
      },
    );
    const finished = Promise.race([conversation, ended]).finally(() => void stop());

    return { finished, cancel: stop };
  }

  /**
   * Starts the agent, opens a session in `cwd`, and stops it — no prompt, no
   * work done. Tells whether the agent could take a task right now, so the
   * phone can say "needs sign-in" before the user taps Start.
   */
  async probe(command: Command, cwd: string, timeoutMs = 30_000): Promise<Probe> {
    let child: ChildProcess;
    try {
      child = spawn(command.program, [...command.args], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      return { state: "unavailable", detail: `Could not start it: ${messageOf(error)}` };
    }
    this.live.add(child);

    let timer: NodeJS.Timeout | undefined;
    const failed = new Promise<Probe>((resolve) => {
      child.once("error", (error) =>
        resolve({ state: "unavailable", detail: `Could not start it: ${error.message}` }),
      );
      child.once("exit", (code) =>
        resolve({ state: "unavailable", detail: `It stopped while starting (code ${code}).` }),
      );
    });
    const timedOut = new Promise<Probe>((resolve) => {
      timer = setTimeout(
        () => resolve({ state: "unavailable", detail: "It didn't respond in time." }),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([openSession(child, cwd), failed, timedOut]);
    } finally {
      clearTimeout(timer);
      kill(child);
      this.live.delete(child);
    }
  }

  /** Kills every agent still running. For process exit. */
  killAll(): void {
    for (const child of this.live) kill(child);
  }

  private converse(
    run: AgentRun,
    callbacks: AgentCallbacks,
    child: ChildProcess,
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
        const decision = permissionDecision(params);
        // Only "allow always" was offered: refuse rather than hand out a blanket yes.
        if (decision.choices.length === 0) return { outcome: { outcome: "cancelled" } };
        const choice = await callbacks.decide(decision);
        if (choice === null || isStopped()) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: choice } };
      })
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
        refuseIfStopped();
        const file = await inWorkspace(params.path);
        const { size } = await stat(file);
        if (size > MAX_READ_BYTES) throw new Error(`File is too large to read (${size} bytes)`);
        const content = await readFile(file, "utf8");
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
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        return ctx.buildSession(run.workspaceRoot).withSession(async (session) => {
          this.options.onReady?.(run.agent);
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

/** `initialize` + `session/new`, nothing else. */
async function openSession(child: ChildProcess, cwd: string): Promise<Probe> {
  if (!child.stdin || !child.stdout) return { state: "unavailable", detail: "No stdio" };
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  try {
    await acp.client({ name: "malves" }).connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      await ctx.buildSession(cwd).withSession(async () => {});
    });
    return { state: "ready" };
  } catch (error) {
    if (isAuthRequired(error)) return { state: "needs_sign_in" };
    return { state: "unavailable", detail: messageOf(error) };
  }
}

function isAuthRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === AUTH_REQUIRED
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Allow always" is never offered: one tap on it would stop the agent asking
 * for that tool again, and every decision must come back to the user (§5).
 */
export function permissionDecision(params: acp.RequestPermissionRequest): Decision {
  const call = params.toolCall;
  const where = (call.locations ?? []).map((l) => l.path).join(", ");
  const title = call.title ?? "The agent wants to use a tool";
  return {
    kind: "permission",
    text: where ? `${title}\n${where}` : title,
    choices: params.options
      .filter((o) => o.kind !== "allow_always")
      .map((o) => ({ id: o.optionId, label: o.name })),
    risk: riskOf(call.kind ?? undefined),
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
