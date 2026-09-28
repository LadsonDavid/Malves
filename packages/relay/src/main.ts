#!/usr/bin/env node
import { leadsRoute } from "./leads.js";
import { startRelay } from "./relay.js";

/**
 * Configuration by environment, for Docker:
 *   RELAY_TOKEN   required; the same value is stored in the runner's keychain
 *   RELAY_HOST    default 0.0.0.0 inside the container (Caddy terminates TLS in front)
 *   RELAY_PORT    default 8080
 *   LEADS_UPSTREAM optional, e.g. http://signalstack:8000 — exposes GET /leads/api/* only
 */
const token = process.env.RELAY_TOKEN;
if (!token || token.length < 32) {
  console.error(
    "Set RELAY_TOKEN to a random secret of at least 32 characters (e.g. `openssl rand -base64 32`).",
  );
  process.exit(1);
}

const relay = await startRelay({
  host: process.env.RELAY_HOST ?? "0.0.0.0",
  port: Number(process.env.RELAY_PORT ?? 8080),
  token,
  ...(process.env.LEADS_UPSTREAM ? { http: leadsRoute(process.env.LEADS_UPSTREAM) } : {}),
});
console.log(`malves relay listening on ${relay.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void relay.close().then(() => process.exit(0)));
}
