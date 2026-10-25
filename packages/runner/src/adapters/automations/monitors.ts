import net from "node:net";
import type { MonitorRunner } from "@malves/core";
import type { MonitorSource } from "@malves/protocol";
import { runCommand } from "../assistant/handover.js";

/**
 * Reads monitor sources across commands, URLs, and network ports.
 * Throws when a source cannot be reached or does not match expectations.
 */
export class SystemMonitors implements MonitorRunner {
  constructor(
    private readonly resolveWorkspace?: (id: string) => string | undefined,
    private readonly timeoutMs = 30_000,
  ) {}

  async read(source: MonitorSource): Promise<string> {
    switch (source.kind) {
      case "command": {
        const cwd = (source.workspace_id ? this.resolveWorkspace?.(source.workspace_id) : undefined) ?? process.cwd();
        const out = await runCommand(source.command, cwd, this.timeoutMs);
        return out;
      }
      case "url": {
        const res = await fetch(source.url, {
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000)),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return await res.text();
      }
      case "port": {
        const host = source.host ?? "127.0.0.1";
        return new Promise<string>((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(Math.min(this.timeoutMs, 5_000));
          socket.once("connect", () => {
            socket.destroy();
            resolve(`open ${host}:${source.port}`);
          });
          socket.once("timeout", () => {
            socket.destroy();
            reject(new Error(`Timed out connecting to ${host}:${source.port}`));
          });
          socket.once("error", (err) => {
            socket.destroy();
            reject(err);
          });
          socket.connect(source.port, host);
        });
      }
    }
  }
}
