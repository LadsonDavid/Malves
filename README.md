# malves

> **Status: working prototype, Android only.** A phone app, a desktop runner and
> a Chrome extension, tested end to end; the phone app builds as an installable
> APK. See [Where it stands](#where-it-stands).

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
| 5 | **browser automation** | A Chrome extension that lets the agent use the tab you have open, asking your phone before it acts on a site. No subscription |
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

So: **MIT, no paid tier, no CLA, no hosted relay.** You keep copyright on
what you write. If any of that ever comes up for discussion it happens in a
public issue before it's decided, not after.

## Where it stands

| Piece | State |
|---|---|
| Desktop runner | Works. Runs Claude Code, Codex, Antigravity and Cursor through ACP (Cursor: once its CLI is installed) |
| Android app | Home, Tasks, Leads and Settings tabs. Answer questions with a live countdown; start, stop, reply to and re-run tasks; watch what a running agent is doing; read full results and changes, and commit; continue an earlier conversation; email leads; stop everything from Settings. Follows the phone's dark mode. **Voice:** talk to it in English or Tamil — answer questions, start tasks ("ask Claude to fix the footer"), hear results; hands-free mode reads questions aloud as they arrive (APK) |
| Desktop IDEs | One extension for VS Code, Cursor, Antigravity and Windsurf: from the phone, start the IDE's own agent, open a task's changes there, continue your Claude Code / Codex IDE conversations (or reopen them at the desk); agent questions also appear in the IDE |
| Notifications | Works through the free [ntfy](https://ntfy.sh) app, straight from your computer over Tailscale, with answer buttons on the lock screen |
| Browser automation | Chrome extension, loaded unpacked. Every new site, click and form entry asks your phone first |
| Leads | [signalstack](https://github.com/LadsonDavid/signalstack) on your computer or a server; leads and "Research in browser" on the phone |
| Budget guard | Claude Code and Codex can run on your own free-tier keys through [freellmapi](https://github.com/tashfeenahmed/freellmapi); the phone shows which model answered and asks before a weaker one is used |
| Relay (no Tailscale) | A small server you run yourself ([packages/relay](packages/relay/README.md)); the computer only dials out. Notifications still need Tailscale |

Over mobile data the phone reaches your computer through
[Tailscale](https://tailscale.com) (free for personal use). The full design —
requirements, architecture, security model and tech stack — is in
[ARCHITECTURE.md](ARCHITECTURE.md).

### Trying it

**On the computer** (Node.js 22.12+ and pnpm):

```sh
pnpm install && pnpm build
cp .env.example .env              # optional settings; every line is explained
pnpm malves workspace add ~/code/my-site
pnpm malves serve                 # shows a QR code to pair the phone
```

**On the phone:** install the malves APK (from the repo's Releases, or build
it yourself: Actions → Android APK → Run workflow) and scan the QR code. To use
it away from home, install [Tailscale](https://tailscale.com) on both, or run
your own [relay](packages/relay/README.md). For lock-screen notifications,
install the free [ntfy](https://ntfy.sh) app and tap **Set up notifications**.
Developers can use Expo Go instead: `pnpm --filter @malves/app start`.

In `serve`, type `help` for commands: `pair`, `agents`, `extension` (connect
Chrome), `push` (notifications), `devices`, `revoke`, `stop`. Without a phone,
`pnpm malves run -w my-site "add a demo file"` runs a task in the terminal with
the demo agent (no API key). Questions nobody answers in time (`--timeout`,
default 10 minutes) stop the task — silence never means yes. `pnpm test` runs
the tests.

## Contributing

Not open for code contributions yet; issues and ideas are welcome. The security model is in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-security). Read it
before anything else — a phone that makes your desktop run code is remote code
execution as a feature, and that deserves a threat model before it deserves a
demo.
