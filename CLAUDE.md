# malves — context for Claude

## What this is

A **final year university project**, released as open source (MIT, no paid
tier, ever). It must satisfy all seven pain points in [idea.txt](idea.txt) —
these are non-negotiable; solve them differently if needed, but never drop one.

- [ARCHITECTURE.md](ARCHITECTURE.md) is the source of truth: requirements R1–R10,
  design, security, ADRs, tech stack (§15), build order (§13).
- **Status:** steps 1–2 built and tested on a real phone (demo + Claude).
  Antigravity built (official server, API key from `.env`; start malves with
  `node --env-file=.env …`). Browser (Chrome extension, ARCHITECTURE §5) built,
  awaiting a real test. Cursor waits on the CLI install. Lead engine built
  (signalstack `/api/leads` → `serve --leads <url>` → app Leads screen), awaiting a
  real-data test. Next: continuing existing agent sessions, then step 3 (push).
- **Never commit `.env`** — it holds the Gemini API key; `.gitignore` covers it.
- **Expo changes APIs every SDK.** Check the versioned docs for the SDK in
  `packages/app/package.json` (docs.expo.dev/versions/v<major>.0.0/) before
  writing Expo code — don't rely on memory.

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
| Publishing the Chrome extension to the Web Store | It's loaded unpacked; all logic is bundled, the runner sends only operation names (no remote code). See ARCHITECTURE §5 |
| Browser tasks in a separate Playwright browser | Owner chose Claude-in-Chrome style: real Chrome, current tab, tools always available |
| Free LLM tiers as the foundation | Tiers are shrinking and some train on prompts. freellmapi with the user's own keys; never silently downgrade |
| iOS in v1, shared team accounts, code editing on the phone, screen mirroring | Out of scope — see ARCHITECTURE.md §0 |

## Windows traps — the owner develops on Windows

Step 1 passed on Linux and broke on Windows. Don't reintroduce these:

- Never spawn `npx` or any `.cmd` shim — start `node <script>` instead.
- Don't upgrade `better-sqlite3` past 12.11.1 until the new version ships Windows builds.
- Build paths with `node:path` and `fileURLToPath`, never string concatenation or `.pathname`.
- `.gitattributes` keeps LF everywhere; CI runs on Windows too — keep it green there.

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
