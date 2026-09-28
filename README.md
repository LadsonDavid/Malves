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

- **lead engine** — working, separate repo, Apache-2.0
- **desktop runner** — designed, not built
- **Android app** — designed, not built
- **browser automation** — designed, not built

The full design — requirements, architecture, security model and tech stack — is
in [ARCHITECTURE.md](ARCHITECTURE.md).

## Contributing

Not open for contributions yet; the project is still at the design stage. The
security model is in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-security). Read it
before anything else — a phone that makes your desktop run code is remote code
execution as a feature, and that deserves a threat model before it deserves a
demo.
