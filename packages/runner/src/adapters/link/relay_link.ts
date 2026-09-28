import WebSocket from "ws";
import { PhoneSession, type SessionContext } from "./session.js";

export type RelayLinkOptions = {
  /** The relay's base URL, e.g. wss://relay.example.com */
  url: string;
  /** The relay token, from the keychain. */
  token: string;
  onStatus?: (status: "connected" | "disconnected", detail?: string) => void;
  backoff?: { baseMs: number; maxMs: number };
};

export type RelayLink = {
  /** The address phones use; it goes into the pairing QR code. */
  phoneUrl: string;
  close(): void;
};

/**
 * Topology B: the runner dials out to the owner's relay and keeps one
 * connection open, so no port is opened on the home network. Each phone
 * arrives as a stream id on that connection and gets its own PhoneSession —
 * the same end-to-end encrypted session as over Tailscale.
 */
export function connectRelay(ctx: SessionContext, o: RelayLinkOptions): RelayLink {
  const base = o.url.replace(/\/+$/, "");
  const runnerUrl = `${base}/runner/${ctx.runnerId}`;
  let socket: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  let retry: NodeJS.Timeout | undefined;
  const sessions = new Map<string, PhoneSession>();

  const open = () => {
    const ws = new WebSocket(runnerUrl, {
      headers: { authorization: `Bearer ${o.token}` },
      maxPayload: 1024 * 1024,
    });
    socket = ws;

    ws.on("open", () => {
      attempt = 0;
      o.onStatus?.("connected");
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let frame: { c?: unknown; open?: unknown; d?: unknown; close?: unknown };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      const c = frame.c;
      if (typeof c !== "string") return;

      if (frame.open === true) {
        const session = new PhoneSession(ctx, {
          send: (text) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ c, d: text }));
          },
          close: () => {
            // Only tell the relay if the phone side is still there.
            if (sessions.delete(c) && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ c, close: true }));
            }
          },
        });
        sessions.set(c, session);
      } else if (typeof frame.d === "string") {
        sessions.get(c)?.receive(frame.d);
      } else if (frame.close === true) {
        const session = sessions.get(c);
        sessions.delete(c);
        session?.close();
      }
    });

    ws.on("close", (code, reason) => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
      o.onStatus?.("disconnected", `${code} ${reason.toString()}`.trim());
      if (closed) return;
      // Capped exponential backoff with full jitter.
      const { baseMs, maxMs } = o.backoff ?? { baseMs: 1000, maxMs: 60_000 };
      const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
      attempt += 1;
      retry = setTimeout(open, Math.floor(Math.random() * cap) + 1);
    });

    ws.on("error", () => {
      // 'close' follows and schedules the retry.
    });
  };

  open();

  return {
    phoneUrl: `${base}/phone/${ctx.runnerId}`,
    close() {
      closed = true;
      clearTimeout(retry);
      for (const session of sessions.values()) session.close();
      socket?.close();
    },
  };
}
