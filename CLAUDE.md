# malves — context for Claude

## What this is

A **final year university project**, released as open source (Apache-2.0, no paid
tier, ever). It must satisfy all seven pain points in [idea.txt](idea.txt) —
these are non-negotiable; solve them differently if needed, but never drop one.

- [ARCHITECTURE.md](ARCHITECTURE.md) is the source of truth: requirements R1–R10,
  design, security, ADRs, tech stack (§15), build order (§13).
- **Status:** all eight build steps implemented (see ARCHITECTURE.md §16 for what
  changed and what is still unverified). Next: run it on a real phone and real
  agents; merge the signalstack `/api/leads` change in that repo.

## How the owner wants to work

- **Do not write code or create files unless explicitly asked.** Explain and plan
  first; ask before implementing. This has been a clear correction before.
- When asked to use a skill, MCP, or research, actually invoke it — don't answer
  from memory.
- Plain, direct language. Report findings honestly, including bad news.
- Always confirm before pushing, and especially before force-pushing.

## Git identity — check at session start

Commits in this repo must be authored by:

```
git config user.name  "LadsonDavid"
git config user.email "160389072+LadsonDavid@users.noreply.github.com"
```

Set these locally in every new environment. Never commit here as
`Malveon-Workspace` (the owner's global identity for other projects).

## Decisions already made — don't reopen without a new reason

| Decision | Why |
|---|---|
| One owner per desktop, no team accounts | Simplest backend; owner's choice |
| Works anywhere over mobile data | Point 2; topology A (Tailscale) or B (own relay) |
| Lead engine on desktop **or** server | Owner's choice; user picks at setup |
| Android only for v1 | iOS push must transit APNs |
| ACP (runner ↔ agents) + own small protocol (phone ↔ runner) | ACP has ~50 agents; its remote transport is WIP |
| TypeScript + Expo; signalstack stays Python | Official ACP SDK is TS; reuse Happy; shared `protocol` package |
| One `questions.ask()` module for every human decision | Agent questions, permissions, browser gate, budget floor, commit approval |
| Unanswered question → **stop**, never proceed | R3 |
| Push is a hint; the event log is the truth | Lost pushes never break anything |

## Ruled out — don't re-propose

| Idea | Why not |
|---|---|
| Designing a custom agent protocol | ACP exists (Zed, JetBrains, Google, Devin Desktop) |
| GUI/accessibility automation of editors | Cursor has a headless CLI; Antigravity has an SDK + ACP server; Windsurf is now Devin Desktop with ACP |
| Driving Antigravity via a consumer Google login | Google suspended accounts for this in Feb 2026. API key only |
| Publishing a Chrome extension | MV3 bans remote code; browser tasks use Playwright behind an approval gate |
| Free LLM tiers as the foundation | Tiers are shrinking and some train on prompts. freellmapi with the user's own keys; never silently downgrade |
| iOS in v1, shared team accounts, code editing on the phone, screen mirroring | Out of scope — see ARCHITECTURE.md §0 |

## Academic integrity — required

- Every piece of code borrowed from Happy, Runmote or elsewhere goes in
  `THIRD-PARTY.md` (create it on first copy) **and** the dissertation's
  declaration of original work. Keep original MIT/Apache notices.
- AGPL software (e.g. Twenty CRM) may only be used as a separate process over its
  API, never linked into this codebase.

## Open decisions

- **Dissertation contribution statement:** (A) a standard remote transport
  profile for ACP — verify the gap in the ACP spec repo first — or (B) a
  comparative security analysis of Happy, Runmote and Claude Remote Control's
  pairing designs. Not yet chosen.
- Week-1 verifications: see ARCHITECTURE.md §14 and §15 "Check before committing".

## Related repo

**signalstack** — https://github.com/LadsonDavid/signalstack (Python, Apache-2.0).
The lead engine (points 1, 7). Stays a separate process reached over HTTP; the
runner never imports it. Its commits use
`LadsonDavid <ladsonselvam1998@gmail.com>`.
