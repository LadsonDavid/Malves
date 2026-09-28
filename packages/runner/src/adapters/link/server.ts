import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { PhoneSession, type SessionContext } from "./session.js";

export type LinkServer = { url: string; close(): Promise<void> };

const MAX_FRAME = 256 * 1024;

/**
 * The phone link for topology A: a WebSocket server bound to one address —
 * the Tailscale IP, never 0.0.0.0 — so it is reachable only through the
 * owner's tailnet (WireGuard). The payload is also end-to-end encrypted.
 */
export function startLinkServer(
  ctx: SessionContext,
  listen: { host: string; port: number },
): Promise<LinkServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: listen.host,
      port: listen.port,
      maxPayload: MAX_FRAME,
    });
    const sessions = new Set<PhoneSession>();

    wss.on("connection", (socket) => {
      const session = new PhoneSession(ctx, {
        send: (text) => socket.send(text),
        close: () => socket.close(),
      });
      sessions.add(session);
      socket.on("message", (data, isBinary) => {
        if (isBinary) session.close();
        else session.receive(data.toString("utf8"));
      });
      socket.on("close", () => {
        sessions.delete(session);
        session.close();
      });
      socket.on("error", () => session.close());
    });

    wss.once("error", reject);
    wss.once("listening", () => {
      const address = wss.address() as AddressInfo;
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve({
        url: `ws://${host}:${address.port}`,
        close: () =>
          new Promise((done) => {
            for (const s of sessions) s.close();
            wss.close(() => done());
          }),
      });
    });
  });
}
