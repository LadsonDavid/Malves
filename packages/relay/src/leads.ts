import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The relay route to the lead engine in topology B (§7). Only read requests
 * to signalstack's JSON API are passed on: GET /leads/api/<path> →
 * GET <upstream>/api/<path>. Its web UI and admin actions (/ops/run,
 * /ops/backup, …) are never reachable through the relay.
 *
 * Trade-off, as in §7: the relay terminates TLS here, so it can read lead
 * traffic. That's acceptable — it's the owner's server and the data comes from
 * public sources. The code path (runner) stays end-to-end encrypted.
 */
export function leadsRoute(upstream: string) {
  const base = upstream.replace(/\/+$/, "");
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = req.url ?? "";
    const match = /^\/leads(\/api\/[A-Za-z0-9/_-]*)(\?[^#]*)?$/.exec(url);
    if (!match) return false;
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end();
      return true;
    }
    const target = `${base}${match[1]}${match[2] ?? ""}`;
    const headers: Record<string, string> = {};
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    fetch(target, { headers, signal: AbortSignal.timeout(20_000) })
      .then(async (up) => {
        res.writeHead(up.status, {
          "content-type": up.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        });
        res.end(Buffer.from(await up.arrayBuffer()));
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "The lead engine is not reachable." }));
      });
    return true;
  };
}
