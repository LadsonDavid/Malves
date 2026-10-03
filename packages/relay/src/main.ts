#!/usr/bin/env node
import { Relay } from "./relay.js";

/**
 * Runs the relay on your own server. Put it behind HTTPS (e.g. Caddy) so the
 * phone and computer connect with wss://. Settings come from the environment:
 *   MALVES_RELAY_TOKEN  required; the same value goes in the computer's .env
 *   PORT                default 7720
 *   HOST                default 127.0.0.1 (the HTTPS proxy in front talks to it)
 */
const token = process.env.MALVES_RELAY_TOKEN ?? "";
if (token.length < 24) {
  console.error("Set MALVES_RELAY_TOKEN to a long random secret (at least 24 characters).");
  process.exit(1);
}
const relay = new Relay({
  token,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 7720),
});
const port = await relay.start();
console.log(`malves relay listening on port ${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void relay.close().then(() => process.exit(0)));
}
