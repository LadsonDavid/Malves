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
  real-data test. Continuing conversations built (Reply, and resume an
  earlier session; ARCHITECTURE §3). Step 3 (push) built with the ntfy app, awaiting a
  real-phone test. Budget guard built (Claude/Codex on free models via freellmapi),
  awaiting a real freellmapi test. Also built: review & commit a task's changes,
  weekly leads digest, Cursor profile (waits on its CLI), Chrome/last-seen on the
  phone, relay (`packages/relay`, topology B), APK workflow + `pnpm malves` +
  `.env.example`. App UX overhaul: tabs (Home/Tasks/Leads/Settings), task screen with
  live activity, notification taps open the task (APK only), dark mode, stop-all.
  Voice (APK): en-IN/en-US/Tamil, rule-based commands, hands-free mode, precise
  dictation via Whisper/freellmapi (ARCHITECTURE "Voice"). IDE companion extension
  (`packages/ide`, ARCHITECTURE "Desktop IDEs"): start the IDE's agent, open changes,
  reopen conversations, answer questions in the IDE — awaiting a real IDE test.
  Malves the assistant (ARCHITECTURE "Malves, the assistant"): brain on freellmapi
  on an Oracle Cloud VM over Tailscale, memory in an Obsidian vault, phone voice
  routed to it with rule fallback, Confirm/Cancel, voice picker, memory screen —
  runner side tested live, phone side awaiting a real test.
  Also built (Oct 6): `malves autostart` (Task Scheduler, Windows), boot-aware
  runner lock, 90 s agent probe; app redesign on the Malveon blueprint system
  (DESIGN.md); Malves watcher (task finished/failed notifications, quiet hours),
  approved lessons/skills, "look at this" vision (tested live), nightly encrypted
  vault backup over SSH (tested live, round trip). Handover mode (shell +
  Chrome + desktop via nut.js fork; screen looks free, clicks/typing read back).
  Sessions (Oct 7): one list across Claude Code, Codex, Cursor (Desktop Bridge) and
  Antigravity (read + continue as new); folders from sessions replace projects.
  Natural voice (Oct 7): streamed brain replies spoken per sentence via Cartesia →
  ElevenLabs → Piper (Oracle) → phone voice; voice picker; talk-over interruption.
  Oct 8: work profile ("About me.md" in the vault, edits only on his yes, weekly
  check), skill library from ~/.claude/skills (shortlist + read_skill), screen any
  time with control from the phone.
  All awaiting real-world tests; see README "Where it stands".
- **Never commit `.env`** — it holds the Gemini API key; `.gitignore` covers it.
- **No Claude attribution:** never add a Claude `Co-Authored-By` line to commits or
  PR descriptions. Open a PR (feature branch → main) for pushed work.
- **Private profile stays local:** only the work profile (`About me.md`) may go to
  the brain; the personal one (`ladson.md`) never leaves the computer.
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
| Push via the ntfy app, with the runner as its server over Tailscale | `expo-unified-push` has no answer buttons (R1) and needs a custom build |
| Malves: the brain proposes tool calls, code decides; risky actions read back in code-written words | Prompt injection and mishearing can't act on their own |
| Malves' memory is an Obsidian vault (Markdown) + SQLite index | Owner can read and edit it; vault is the truth |
| Malves' brain hosted (freellmapi on Oracle free VM), not on the laptop | Owner's laptop is busy with heavy work |
| Handover mode: shell in project folders + Chrome + screen; looking and tests/builds auto, the rest asks; ends **only** on Stop, "I'm back", or 4 h (not on mouse movement or unlock) | Owner's choice (Oct 2026): he may sit at the desk watching it work |
| The phone shows the PC screen live **any time** (~3 fps, ~60 KB/frame) and can control it (tap to click, scroll, type, keys); no fingerprint gate; the PC shows a Windows notification when a phone starts watching or takes control | Owner's choice (Oct 8, 2026), replacing "view only, during handover only" |
| Never work around Windows Defender/antivirus | The desktop-control PowerShell helper was flagged as malicious; evasion is what malware does |
| Desktop IDEs via one companion extension (`packages/ide`), public APIs only | Owner's choice (Oct 2026): IDE agent panels have no public API |
| In handover mode Malves uses editors on screen as a co-developer | Owner's choice (Oct 2026, reversing the earlier ban); every click/keystroke is read back, editor ones say they may accept/reject the AI's change |

## Ruled out — don't re-propose

| Idea | Why not |
|---|---|
| Designing a custom agent protocol | ACP exists (Zed, JetBrains, Google, Devin Desktop) |
| GUI/accessibility automation of editors to run their agents (outside handover) | Cursor has a headless CLI; Antigravity has an SDK + ACP server; Windsurf is now Devin Desktop with ACP |
| Driving Antigravity via a consumer Google login | Google suspended accounts for this in Feb 2026. API key only |
| Publishing the Chrome extension to the Web Store | It's loaded unpacked; all logic is bundled, the runner sends only operation names (no remote code). See ARCHITECTURE §5 |
| Browser tasks in a separate Playwright browser | Owner chose Claude-in-Chrome style: real Chrome, current tab, tools always available |
| Free LLM tiers as the foundation | Tiers are shrinking and some train on prompts. freellmapi with the user's own keys; never silently downgrade |
| iOS in v1, shared team accounts, code editing on the phone | Out of scope — see ARCHITECTURE.md §0 |

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

- **Dissertation contribution statement: decided (Oct 2026) — (B)** a comparative security
  analysis of Happy, Runmote and Claude Remote Control pairing designs, with malves
  as the fourth subject. (A) dropped: ACP now has a draft remote-transport RFD.
- Week-1 verifications: see ARCHITECTURE.md §14 and §15 "Check before committing".

## Related repo

**signalstack** — https://github.com/LadsonDavid/signalstack (Python, Apache-2.0).
The lead engine (points 1, 7). Stays a separate process reached over HTTP; the
runner never imports it. Its commits use
`LadsonDavid <ladsonselvam1998@gmail.com>`.
