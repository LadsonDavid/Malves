# malves

> **Status: working prototype, Android only.** A phone app, a desktop runner, a
> Chrome extension, an IDE extension and Malves (a voice assistant), tested end
> to end in parts; the phone app builds as an installable APK. The newest pieces
> are awaiting a real-phone test. See [Where it stands](#where-it-stands).

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
| 2, 3 | **Android app** | Task-level control of your desktop: questions, results and decisions come to the phone. Not a cursor. A live view of the screen exists too, for Windows, as a fallback |
| 4 | **desktop runner** | Drives your AI coding tool through the [Agent Client Protocol](https://agentclientprotocol.com): Claude Code, Codex, Antigravity and Cursor today. Other ACP agents need a profile in `packages/runner/src/agents.ts` |
| 5 | **browser automation** | A Chrome extension that lets the agent use the tab you have open, asking your phone before it acts on a site. No subscription |
| 6, 7 | **your own model keys** | [freellmapi](https://github.com/tashfeenahmed/freellmapi) spreads calls across your own free-tier keys. A budget guard shows which model answered and never silently downgrades |
| 2, 3 | **Malves** | A voice assistant on top of all of it: talk naturally, it does the work through the pieces above, and asks before anything risky |

### Point 3 is the one that matters

Remote desktop fails on a phone because it gives you a smaller copy of the same
interface. This is not that. You are not moving a cursor — you send a task, and
the only thing that comes back to your phone is **the question the agent got
stuck on**. Everything else stays on the desktop where it belongs.

That reframing is what makes points 2 and 4 solvable at all. A phone is a bad
monitor and an excellent decision device. The live screen view (Windows) is
there for the moments a task can't express what you need. The computer shows a
notice whenever a phone starts watching or takes control.

```
 phone ──▶ runner ──▶   ACP   ──▶ your coding agent
   ▲         │                    (claude, codex, cursor, antigravity)
   └─────────┘
   only questions come back
```

A task goes like this: you describe it on the phone and pick a folder and an
agent. The runner starts that agent in the folder and reads its messages. When
the agent asks something (a permission, a question, a commit), the question goes
to the phone with its choices. An unanswered question stops the task; silence
never means yes. When the task ends, the phone shows the result and the changed
files. In a git project it also asks before committing them.

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
| Desktop runner | Works. Runs Claude Code, Codex, Antigravity and Cursor through ACP (Cursor: once its CLI is installed). Each agent's sign-in is checked at startup, and "needs sign-in" shows on the phone |
| Android app | Home, Work, Leads and Settings tabs, in the Malveon blueprint design (paper and navy, Geist and Fraunces, light and dark following the phone). Answer questions with a live countdown; start, stop, reply to and re-run tasks; watch what a running agent is doing; read full results and changes, and commit; continue an earlier conversation; open a pre-filled email to a lead's contact; stop everything from Settings. **Voice:** English (India or US) or Tamil; hands-free mode reads questions aloud as they arrive. Listening needs the APK |
| Malves, the assistant | Talk naturally (sloppy, mixed English and Tamil is fine). It starts and checks on tasks, answers questions, reads leads, and asks your IDE's agent; anything risky is read back in its own words and needs your yes (said, or the Confirm button). Its brain runs on freellmapi on a free cloud server, not your laptop |
| Memory and learning | Remembers what you tell it as notes in your Obsidian vault (you can read, edit or delete them; Settings shows them). Proposes lessons and reusable skills, saved only on your yes. Backed up nightly, encrypted, to your own server |
| Look at this | Point the phone camera at a screen, an error or a diagram; Malves says what it sees and can act on it |
| Handover mode | "I'm leaving, take over": Malves runs commands in your projects, uses Chrome and your desktop (mouse, keyboard and screen: Windows only), including your editors, as a co-developer. Reading and tests/builds go by themselves; everything else is read back for your yes; passwords and sign-ins are off limits. Ends on Stop, when you're back, or after four hours |
| Your profile | Malves knows your work profile (About me.md in its vault) and keeps it true: it drafts changes from what you do, and writes them only on your yes |
| Your skill library | Malves draws on your `~/.claude/skills` for advice and says which one it used |
| Your screen | Watch your computer's screen from the phone any time, and click, scroll and type on it. Windows only. The computer shows a notice when it's watched or controlled |
| Malves calls you | "Call me when Codex finishes": your phone rings with Android's call screen. Needs your own Firebase project (see [Configuration](#configuration)). Answer and talk it through |
| Natural voice | Malves speaks in a natural voice as soon as its first sentence is written (Cartesia, then ElevenLabs, then Piper on your server; the phone's voice if all fail). Tamil and English voices to pick from; talk over it to stop it |
| Sessions | Every Claude Code, Codex, Cursor and Antigravity session on your computer in one list (Work → Sessions), readable from the phone. Claude Code and Codex conversations continue in the same session. Cursor's continue only through its Desktop Bridge (Beta). Antigravity's start a new session with the story so far |
| Desktop IDEs | One extension for VS Code, Cursor, Antigravity and Windsurf. Connects in VS Code and Antigravity; the phone side awaits a real test. From the phone: start the IDE's own agent (VS Code starts it; Cursor pre-fills it, and you press Enter at the desk), open a task's changes, reopen Claude Code or Codex conversations. Agent questions also appear in the IDE |
| Notifications | Through the free [ntfy](https://ntfy.sh) app, straight from your computer over Tailscale: questions with answer buttons on the lock screen, and "task finished / couldn't finish" (with quiet hours) |
| Browser automation | Chrome extension, loaded unpacked. Every new site, click and form entry asks your phone first |
| Leads | [signalstack](https://github.com/LadsonDavid/signalstack) on your computer or a server; leads and "Research in browser" on the phone |
| Budget guard | Claude Code and Codex can run on your own free-tier keys through [freellmapi](https://github.com/tashfeenahmed/freellmapi); the phone shows which model answered and asks before a model below your quality floor is used |
| Relay (no Tailscale) | A small server you run yourself ([packages/relay](packages/relay/README.md)); the computer only dials out. Notifications still need Tailscale |

Over mobile data the phone reaches your computer through
[Tailscale](https://tailscale.com) (free for personal use). The full design —
requirements, architecture, security model and tech stack — is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Trying it

### What you need

- **Node.js 22.12+** and pnpm. The repo pins pnpm through `packageManager`, so
  `corepack enable` is enough.
- **Tailscale** on the computer and the phone, or your own
  [relay](packages/relay/README.md).
- **At least one coding agent**, signed in on the computer. The runner's data
  folder is `~/.malves` (set `MALVES_HOME` to move it):
  - **Claude Code:** run `claude` in a terminal and type `/login`.
  - **Codex:** run `codex login`.
  - **Cursor:** install its CLI, then run `agent login` (or set `CURSOR_API_KEY`).
  - **Antigravity:** Google's ACP server is not bundled. Put `agy_acp_server.exe`
    (Windows) or `agy_acp_server.par` in `~/.malves/agents/antigravity/`, and set
    `GEMINI_API_KEY`. Only ever an API key, never a personal Google login.

### On the computer

Needs Node.js and pnpm (above):

```sh
pnpm install && pnpm build
cp .env.example .env              # optional settings; every line is explained
pnpm malves workspace add ~/code/my-site
pnpm malves serve                 # shows a QR code to pair the phone
```

`pnpm malves` reads `.env` from the folder you run it in.

On Windows, `pnpm malves autostart on` starts `serve` in the background every time you log in: no window, output in `~/.malves/serve.log`, restarted if it crashes (`autostart status` checks it, `autostart off` undoes it). Type its commands from any terminal with `pnpm malves console` (e.g. `pnpm malves console pair` for a QR code).

**Malves (optional).** It needs an OpenAI-compatible brain and a folder for its
memory. We run [freellmapi](https://github.com/tashfeenahmed/freellmapi) on a
free Oracle Cloud VM, reached over Tailscale, with free-tier provider keys
(Groq and Cerebras make it quick). In `.env`:

```sh
MALVES_MODELS_URL=http://<your-server>:3001   # freellmapi
MALVES_MODELS_KEY=...                         # its unified API key
MALVES_VAULT=D:\Notes\Malves                  # an Obsidian vault folder (its memory)
```

`serve` then prints "Malves (assistant): on". `pnpm malves backup now` backs up
the vault by hand; `pnpm malves backup restore <file> --to <new folder>` opens a
backup (keep a copy of `~/.malves/backup.key`: without it backups can't be opened).

**On the phone:** install the malves APK (from the repo's Releases, or build
it yourself: Actions → Android APK → Run workflow) and scan the QR code. To use
it away from home, install [Tailscale](https://tailscale.com) on both, or run
your own [relay](packages/relay/README.md). For lock-screen notifications,
install the free [ntfy](https://ntfy.sh) app and tap **Set up notifications**.
Developers can use Expo Go instead: `pnpm --filter @malves/app start`. Expo Go
can read replies aloud, but it can't listen (that needs the APK) and can't ring
for calls.

### Commands

From the shell:

```
malves serve [--host <ip>] [--port 7717] [--timeout 10m] [--leads <url>] [--relay wss://…]
malves workspace add <folder> [--name <name>]  |  list  |  remove <id>
malves agents                                   check which agents are ready
malves run [-w <id|name>] [-a <agent>] <task…>  run one task in this terminal
malves log [--since <seq>]                      print the event log
malves autostart on|off|status|start           Windows: serve at login
malves console [command]                        type serve's commands in a running background serve
malves backup now  |  restore <file> --to <folder>
```

`run` defaults to the demo agent, which needs no API key. Questions nobody
answers in time (`--timeout`, default 10 minutes) stop the task. Silence never
means yes.

Typed into `serve` (or `malves console`):

| Command | What it does |
|---|---|
| `pair`, `pair text` | Show a pairing QR code (valid 2 minutes); `text` prints it for an emulator |
| `agents` | Check which agents are ready, e.g. after signing in |
| `push`, `push new` | Notification setup; `new` makes a new topic and cuts off subscribed phones |
| `extension`, `extension new` | Connect Chrome; `new` replaces its code |
| `ide` | How to connect VS Code, Cursor, Antigravity or Windsurf |
| `devices`, `revoke <id>` | List paired phones; unpair one at once (a lost phone) |
| `add <folder>` | Register a project folder the phone can start tasks in |
| `1`, `2`, … | Answer the open question from this terminal |
| `stop` | Stop every running task |

`pnpm test` runs the tests.

## Configuration

Everything is optional except what the feature you want needs. `.env.example`
has the same list with a line of explanation for each.

| Variable | What it does |
|---|---|
| `GEMINI_API_KEY` | Antigravity's Gemini API key |
| `CURSOR_API_KEY` | Lets Cursor's CLI sign in without `agent login` |
| `MALVES_MODELS_URL`, `MALVES_MODELS_KEY` | Your freellmapi and its unified key. With both set, "Claude (free models)" and "Codex (free models)" appear |
| `MALVES_MODELS_ALLOW` | The quality floor: models allowed without asking, e.g. `gemini-2.5-pro,deepseek`. Empty allows any |
| `MALVES_VAULT` | The Obsidian vault folder that holds Malves' memory. Malves is off without it |
| `MALVES_ASSISTANT_MODEL`, `MALVES_EMBED_MODEL`, `MALVES_WHISPER_MODEL` | Optional model overrides for the brain, embeddings and dictation |
| `MALVES_VISION_MODEL` | Vision models for "look at this", comma-separated, tried in order |
| `MALVES_SKILLS` | Your skill library folder (default `~/.claude/skills`) |
| `MALVES_QUIET_HOURS` | e.g. `22-7`: no "task finished" notifications then. Questions always notify |
| `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY` | Natural voices. Either may be empty |
| `MALVES_PIPER_URL` | Piper on your own server, e.g. `http://100.69.0.115:5005` (tailnet only) |
| `MALVES_LEADS_URL`, `MALVES_LEADS_KEY` | signalstack, and its `UI_KEY` if it has one (sent as a header, never in the URL) |
| `MALVES_RELAY_URL`, `MALVES_RELAY_TOKEN` | The relay on your server (`--relay` does the same for the URL) |
| `MALVES_FCM_KEY` | Path to your Firebase service-account JSON, kept outside the repo. The phone build also needs `packages/app/google-services.json` (git-ignored) |
| `MALVES_BACKUP_SSH`, `MALVES_BACKUP_SSH_KEY` | Nightly encrypted backup target (`user@host`) and the key file to log in with |
| `MALVES_HOME` | The data folder (default `~/.malves`) |

`MALVES_DEMO_*` configure the demo agent that the tests use. You don't need them.

### Local ports

The local ports each have a secret in the data folder. The IDE bridge and the
console refuse any request with an `Origin` header (that is what a web page
sends). The Chrome bridge accepts only a `chrome-extension://` origin.

| Port | What | Reachable from |
|---|---|---|
| 7717 | Phone link | The Tailscale address when there is one; with `--host`, the same Wi-Fi; otherwise only this computer. Every message is encrypted, and a phone must be paired first |
| 7718 | Chrome bridge | `127.0.0.1`, from the malves extension only (origin and secret) |
| 7719 | Notifications (ntfy protocol) | The Tailscale address only, because the messages are plain JSON |
| 7720 | Relay (on your server) | Anyone can connect, but only a computer with `MALVES_RELAY_TOKEN` can register, and the relay only passes encrypted traffic |
| 7721 | IDE bridge | `127.0.0.1`, from malves' IDE extension only (secret) |
| 7722 | `malves console` | `127.0.0.1`, with the console secret |

## Repository layout

| Path | What it is |
|---|---|
| `packages/protocol` | Message schemas (zod), NaCl encryption and the phone ↔ runner link. Shared by everything else |
| `packages/core` | The rules: tasks, questions, workspaces, devices and the append-only event log. Depends only on protocol |
| `packages/runner` | The `malves` desktop process: agents over ACP, the phone link, Chrome, IDEs, sessions, notifications, the budget guard, Malves |
| `packages/relay` | Optional blind WebSocket forwarder, for use without Tailscale |
| `packages/app` | The Android app (Expo SDK 57, React Native 0.86) |
| `packages/extension` | The Chrome extension (Manifest V3, loaded unpacked) |
| `packages/ide` | The IDE companion, `malves-ide`, packaged as `malves.vsix` |

The core never names ACP, Chrome, freellmapi, Tailscale, ntfy or SQLite. Those
sit behind ports the core owns, in `packages/runner/src/adapters/`, and
`packages/core/test/boundary.test.ts` fails if the rule is broken. The full design
is in [ARCHITECTURE.md](ARCHITECTURE.md). The phone's visual system is in
[DESIGN.md](DESIGN.md). The seven pain points this answers are in
[idea.txt](idea.txt).

## Development

```sh
pnpm install
pnpm build          # TypeScript project references, then the Chrome and IDE extensions
pnpm typecheck      # every package, including the app and the tests
pnpm lint           # Biome
pnpm format         # Biome, writes the changes
pnpm test           # Vitest
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint and tests on Ubuntu and
Windows, with Node 22 and 24. The APK workflow builds the phone app with Expo
prebuild and Gradle. `pnpm --filter malves-ide package` builds `malves.vsix`.

A few rules that come from the code:

- Windows is in CI on purpose. Never spawn `npx` or a `.cmd` shim; start
  `node <script>` instead, and build paths with `node:path`.
- `better-sqlite3` stays pinned to 12.11.1 until a newer version ships Windows
  builds.
- Expo changes its APIs with every SDK. Check the docs for the version in
  `packages/app/package.json` before writing Expo code.
- Code copied from another project goes in [THIRD-PARTY.md](THIRD-PARTY.md), with
  its licence notice kept.

## Contributing

Not open for code contributions yet; issues and ideas are welcome. The security model is in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-security). Read it
before anything else — a phone that makes your desktop run code is remote code
execution as a feature, and that deserves a threat model before it deserves a
demo.

## License

MIT. See [LICENSE](LICENSE). Borrowed code and designs are listed in
[THIRD-PARTY.md](THIRD-PARTY.md).
