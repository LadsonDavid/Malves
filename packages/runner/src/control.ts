import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";
import { encodeInvite } from "@malves/protocol";
import type { Runner } from "./wire.js";

/**
 * Local control of a running `malves serve`: pairing, "stop everything",
 * workspaces and devices. It listens on a Unix socket inside the owner-only
 * data directory (a named pipe on Windows), never on the network.
 */

export type ControlRequest =
  | { cmd: "status" }
  | { cmd: "pair" }
  | { cmd: "stop" }
  | { cmd: "workspace.add"; name: string; path: string }
  | { cmd: "workspace.list" }
  | { cmd: "workspace.remove"; id: string }
  | { cmd: "devices.list" }
  | { cmd: "devices.revoke"; id: string };

export type ControlResponse = { ok: true; data?: unknown } | { ok: false; error: string };

export type ControlContext = { linkUrl?: string };

export async function handleControl(
  runner: Runner,
  req: ControlRequest,
  ctx: ControlContext,
): Promise<ControlResponse> {
  try {
    switch (req.cmd) {
      case "status":
        return {
          ok: true,
          data: {
            runner_id: runner.identity.runnerId,
            name: runner.name,
            link_url: ctx.linkUrl ?? null,
            devices: runner.devices.list().length,
            workspaces: runner.workspaces.list().length,
            active_tasks: runner.tasks
              .list()
              .filter((t) => !["done", "failed", "stopped"].includes(t.state)).length,
            open_questions: runner.questions.pending().length,
          },
        };
      case "pair": {
        if (!ctx.linkUrl) return { ok: false, error: "The phone link is not running." };
        const { secret, expiresAt } = runner.devices.startPairing();
        const invite = encodeInvite({
          publicKey: runner.identity.keyPair.publicKey,
          secret,
          url: ctx.linkUrl,
          name: runner.name,
        });
        return { ok: true, data: { invite, expires_at: expiresAt } };
      }
      case "stop":
        await runner.tasks.stopAll();
        return { ok: true };
      case "workspace.add":
        return { ok: true, data: runner.workspaces.register(req.name, req.path) };
      case "workspace.list":
        return { ok: true, data: runner.workspaces.list() };
      case "workspace.remove":
        return runner.workspaces.remove(req.id)
          ? { ok: true }
          : { ok: false, error: `No workspace ${req.id}` };
      case "devices.list":
        return {
          ok: true,
          data: runner.devices
            .list()
            .map((d) => ({ id: d.id, name: d.name, push: Boolean(d.push) })),
        };
      case "devices.revoke":
        return runner.devices.revoke(req.id)
          ? { ok: true }
          : { ok: false, error: `No device ${req.id}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function controlPath(dir: string): string {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\malves-${hash}`;
  }
  return path.join(dir, "control.sock");
}

export function startControlServer(
  runner: Runner,
  ctx: ControlContext,
): Promise<{ close(): void }> {
  const where = controlPath(runner.dir);
  if (process.platform !== "win32") rmSync(where, { force: true });
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) return socket.destroy();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response: ControlResponse;
      try {
        response = await handleControl(runner, JSON.parse(buffer.slice(0, newline)), ctx);
      } catch {
        response = { ok: false, error: "bad request" };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(where, () => {
      if (process.platform !== "win32") chmodSync(where, 0o600);
      resolve({ close: () => server.close() });
    });
  });
}

/** Sends one request to a running daemon. Resolves undefined if none is running. */
export function sendControl(
  dir: string,
  req: ControlRequest,
): Promise<ControlResponse | undefined> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(controlPath(dir));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer) as ControlResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined);
      else reject(error);
    });
  });
}
