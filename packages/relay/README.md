# malves relay

For using malves **without Tailscale** (topology B in
[ARCHITECTURE.md](../../ARCHITECTURE.md)): a small server you run yourself,
so your phone reaches your computer over the internet while your computer only
dials out — no ports opened at home.

It is a blind pipe. The phone and computer encrypt everything end to end and
check each other with a challenge handshake, so the relay can't read or change
anything. Its token only stops strangers from registering as your computer.

## Run it on your server

Needs Node.js 22.12+ and a domain pointing at the server.

```sh
pnpm install && pnpm --filter @malves/relay build
MALVES_RELAY_TOKEN=<a long random secret> node packages/relay/dist/main.js
```

It listens on `127.0.0.1:7720` (`PORT`, `HOST` to change). Put HTTPS in front,
for example with [Caddy](https://caddyserver.com), which gets certificates by
itself:

```
relay.example.com {
	reverse_proxy 127.0.0.1:7720
}
```

## Point your computer at it

In the project's `.env` on your computer:

```
MALVES_RELAY_URL=wss://relay.example.com
MALVES_RELAY_TOKEN=<the same secret>
```

Start `malves serve` as usual; it prints "Relay connected." Pair the phone with
`pair` — the QR code now points at the relay.

**Limit:** notifications (the ntfy app) still need Tailscale; without it,
open the app to see and answer questions.
