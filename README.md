# malves

> **Status: design stage. No code yet.** This repo is the problem statement and
> the architecture. If you want something you can install today, come back later.
> If you want to shape it before it sets, now is the only time that's possible.

## The problem

An early-stage team of two or three people needs roughly the same tooling as a
funded one, and gets quoted the same per-seat prices. Seven specific walls, all
of them the same wall:

| | Pain | Today |
|---|---|---|
| 1 | Lead generation | $50/month minimum, per seat, before you have a customer |
| 2 | You aren't at your desk | Work stops. The machine that can do it is at home |
| 3 | So use remote desktop? | Pixel mirroring on a 6-inch screen. Dragging a cursor with your thumb is not a workflow |
| 4 | Remote agent control | Exists for Claude and Codex. Not Cursor, not Antigravity, not the tool you actually use |
| 5 | Browser automation | Needs a Claude or Comet subscription on top of everything else |
| 6 | Credits | Drained in days, then you stop working until the reset |
| 7 | Budget | There isn't one |

Every one of these has a paid answer. Stacked up, the paid answers cost more
per month than the team's entire tooling budget — and you are renting capability
your own hardware already has.

## What this is

**A self-hosted operations stack for teams with no budget.** Your desktop keeps
the compute and the subscriptions you already pay for. Your phone becomes the
control surface. Your code never passes through anyone else's server in readable
form, and there is no per-seat bill.

| Answers | Piece | What it does |
|---|---|---|
| 1, 6, 7 | **lead engine** | Scrapes public buying signals, scores accounts, self-hosted. Already exists: [signalstack](https://github.com/LadsonDavid/signalstack) |
| 2, 3 | **Android app** | Task-level control of your desktop. Not a screen. Not a cursor |
| 4 | **desktop runner** | Drives your AI coding tool through the [Agent Client Protocol](https://agentclientprotocol.com) (Claude Code, Codex, Antigravity and ~50 more), plus a wrapper for Cursor |
| 5 | **browser automation** | Playwright on your desktop, behind a phone-approval gate. No subscription |
| 6, 7 | **your own model keys** | [freellmapi](https://github.com/tashfeenahmed/freellmapi) or any OpenAI-compatible endpoint, with a budget guard that never silently downgrades |

### Point 3 is the one that matters

Remote desktop fails on a phone because it gives you a smaller copy of the same
interface. This is not that. You are not moving a cursor — you send a task, and
the only thing that comes back to your phone is **the question the agent got
stuck on**. Everything else stays on the desktop where it belongs.

That reframing is what makes points 2 and 4 solvable at all. A phone is a bad
monitor and an excellent decision device.

```
 phone ──▶ runner ──▶   ACP   ──▶ your coding agent
   ▲         │                    (cursor, claude, codex, antigravity...)
   └─────────┘
   only questions come back
```

## Why open source, and staying that way

Two reasons, both structural rather than idealistic.

**The people who can keep a tool working are the people who use it.** Editors that
don't speak ACP need wrappers, and those break whenever the editor changes. Users
of those editors are the ones who notice first.

**The whole premise is "don't pay rent for this."** A paid tier would contradict
point 7, which is the point of the project.

So: **Apache-2.0, no paid tier, no CLA, no hosted relay.** You keep copyright on
what you write. If any of that ever comes up for discussion it happens in a
public issue before it's decided, not after.

## Where it stands

All eight build steps in [ARCHITECTURE.md §13](ARCHITECTURE.md#13-build-order) are
implemented. What has and hasn't been verified is listed honestly in
[ARCHITECTURE.md §16](ARCHITECTURE.md#16-what-the-build-changed-and-what-is-verified).
In short: the desktop runner, relay, browser gate, budget guard and push are
tested end to end; the Android app bundles and type-checks but **has not yet
run on a phone**, and its notification module has not been compiled.

- **lead engine** — separate repo ([signalstack](https://github.com/LadsonDavid/signalstack)); needs its `/api/leads` change
- **desktop runner** — `packages/runner`
- **Android app** — `packages/app` (Expo, development build)
- **relay** (optional server) — `packages/relay`, `deploy/`

## Setting it up

Needs Node.js 22.12+, pnpm, and on the desktop an OS keychain (macOS Keychain,
Windows Credential Manager, or a Secret Service keyring on Linux). Keys are
never written to files.

```sh
pnpm install && pnpm build
alias malves="node $PWD/packages/runner/dist/main.js"

malves workspace add ~/code/my-site      # folders the phone may start tasks in
malves agents                            # which agents are installed
malves serve                             # keep this running
malves pair                              # in another terminal: scan with the app
```

**Topology A (free):** install Tailscale on the desktop and the phone. `malves serve`
listens on the desktop's Tailscale address only. Push goes through ntfy.sh as
encrypted Web Push; install the ntfy app on the phone, then tap *Notifications*
on the computer in the malves app.

**Topology B (own server, ~$5/month):** on the server,
`cp deploy/server.env.example deploy/.env`, fill it in, and
`docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d`. On
the desktop, `malves secret set RELAY_TOKEN` and add to `~/.malves/config.json`:

```json
{ "relay": { "url": "wss://relay.example.com" } }
```

**Agents:** `claude`, `codex`, `cursor` and `antigravity` are built in; each uses
its own login or API key (`malves secret set CURSOR_API_KEY`, `GEMINI_API_KEY`).
Add others, e.g. a cheap agent on free models, in `config.json`:

```json
{
  "budget": {
    "free": { "url": "http://127.0.0.1:3001/v1" },
    "own": { "url": "https://openrouter.ai/api/v1", "key": "OWN_API_KEY" },
    "floor": ["claude-*", "gpt-5*", "qwen3-coder*"]
  },
  "agents": [
    { "name": "cheap", "label": "OpenCode on free models",
      "program": "opencode", "args": ["acp"], "budget": "openai" }
  ]
}
```

Agents with `"budget"` go through the budget guard, which records which model
really answered and asks before any weaker one takes over.

**Leads:** run signalstack with a `UI_KEY`, then `malves secret set LEADS_KEY`
(same value) and `malves leads-code --url <address>`; scan it in the app's Leads tab.

**Without a phone:** `malves run -w my-site "add a demo file"` runs one task
with the built-in demo agent and asks its question in the terminal.

`pnpm test` runs the test suite (the browser gate test needs Chromium; set
`MALVES_TEST_CHROMIUM` to its path).

## Contributing

Not open for contributions yet; the project is a final-year university project
and is still being evaluated. The
security model is in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-security). Read it
before anything else — a phone that makes your desktop run code is remote code
execution as a feature, and that deserves a threat model before it deserves a
demo.
