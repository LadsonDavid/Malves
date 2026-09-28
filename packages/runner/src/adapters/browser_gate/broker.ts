import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRun, Core, Decision } from "@malves/core";
import type { RunExtras } from "../acp/host.js";

type Registration = { taskId: string; token: Buffer; dir: string };

export type BrokerOptions = {
  core: () => Core;
  /** The gate script; defaults to the built browser-gate.js next to this package. */
  gateCommand?: { command: string; args: string[] };
  browserExecutable?: string;
  noSandbox?: boolean;
};

/**
 * Connects each browser gate process to its task's questions. Listens on
 * 127.0.0.1 only; every request needs the random token that was handed to
 * that task's gate, so a gate can only ask about its own task.
 */
export class GateBroker {
  private server: Server | undefined;
  private url = "";
  private readonly byTask = new Map<string, Registration>();

  constructor(private readonly o: BrokerOptions) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    // Registrations end with their task.
    this.o.core().log.subscribe((event) => {
      if (
        event.type === "task.updated" &&
        ["done", "failed", "stopped"].includes(event.data.state)
      ) {
        this.unregister(event.data.task_id);
      }
    });
  }

  close(): void {
    for (const taskId of [...this.byTask.keys()]) this.unregister(taskId);
    this.server?.close();
  }

  /** ACP session extras for a browser task: the gate as an MCP server. */
  extrasFor(run: AgentRun): RunExtras {
    if (!run.browser) return {};
    const token = randomBytes(32);
    const dir = mkdtempSync(path.join(tmpdir(), `malves-browser-${run.taskId}-`));
    this.byTask.set(run.taskId, { taskId: run.taskId, token, dir });
    const gate = this.o.gateCommand ?? {
      command: process.execPath,
      args: [fileURLToPath(new URL("../../browser-gate.js", import.meta.url))],
    };
    const env = [
      { name: "MALVES_GATE_URL", value: this.url },
      { name: "MALVES_GATE_TOKEN", value: token.toString("base64url") },
      { name: "MALVES_WORKSPACE", value: run.workspaceRoot },
      { name: "MALVES_BROWSER_DIR", value: dir },
    ];
    if (this.o.browserExecutable) {
      env.push({ name: "MALVES_BROWSER_EXECUTABLE", value: this.o.browserExecutable });
    }
    if (this.o.noSandbox) env.push({ name: "MALVES_BROWSER_NO_SANDBOX", value: "1" });
    return { mcpServers: [{ name: "browser", command: gate.command, args: gate.args, env }] };
  }

  private unregister(taskId: string): void {
    const reg = this.byTask.get(taskId);
    if (!reg) return;
    this.byTask.delete(taskId);
    rmSync(reg.dir, { recursive: true, force: true });
  }

  private async handle(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/ask") return reply(404, {});
    const reg = this.authenticate(req.headers.authorization);
    if (!reg) return reply(401, {});

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 16_000) return reply(413, {});
    }
    let body: { text?: unknown; risk?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, {});
    }
    const decision: Decision = {
      kind: "browser_action",
      text: String(body.text ?? "").slice(0, 1000) || "The browser wants to act.",
      risk: body.risk === "low" || body.risk === "medium" ? body.risk : "high",
      choices: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Don't" },
      ],
    };
    const choice = await this.o.core().tasks.ask(reg.taskId, decision);
    reply(200, { choice });
  }

  private authenticate(header: string | undefined): Registration | undefined {
    const presented = Buffer.from((header ?? "").replace(/^Bearer /, ""), "base64url");
    for (const reg of this.byTask.values()) {
      if (presented.length === reg.token.length && timingSafeEqual(presented, reg.token))
        return reg;
    }
    return undefined;
  }
}
