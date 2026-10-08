# malves

> **Status: working prototype, Android only.** A phone app, a desktop runner, a
> Chrome extension, an IDE extension and Malves (a voice assistant), tested end
> to end in parts; the phone app builds as an installable APK. The newest pieces
> are awaiting a real-phone test. See [Where it stands](#where-it-stands).

## In plain words

You leave your desk, and your computer keeps working for you.

malves turns your phone into a remote control for the computer you already own.
Ask it, by voice or text, to fix a bug, check your leads, or open a web page.
The AI coding tools on your computer (Claude Code, Codex, Cursor, Antigravity)
do the work. When they need a decision, your phone asks you. You tap yes or no,
from anywhere, even on mobile data.

- **Your own computer does the work.** No cloud machine to rent.
- **Nothing happens without you.** Anything that changes something is read back to you first.
- **Free, forever.** MIT licence, no paid tier, no account to create.
- **Private.** The phone and your computer talk over an encrypted link you control.

If you've ever thought "my laptop at home could do this, if only I could reach

it", malves is for you. [Get started](#getting-started).

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

## Getting started

Setup takes about 20 minutes: about 10 on the computer, 5 on the phone, and a
few for the extras you want. You need a **Windows, Mac or Linux computer** and an
**Android phone**. iPhone isn't supported yet.

### Step 1: Get the files

From the [latest release](https://github.com/LadsonDavid/Malves/releases/latest):

| File | What it is |
|---|---|
| `malves.apk` | The phone app |
| `malves-chrome.zip` | The Chrome extension (optional: lets malves use Chrome) |
| `malves.vsix` | The IDE extension (optional: VS Code, Cursor, Antigravity or Windsurf) |

The computer side runs from the source code (step 3).

### Step 2: Prepare the computer

1. Install **[Node.js 22.12 or newer](https://nodejs.org)**.
2. Install **[Tailscale](https://tailscale.com/download)** and sign in. This is
   what lets your phone reach your computer from anywhere, even on mobile data.
3. Install and sign in to **at least one AI coding tool**:

   | Tool | How to sign in |
   |---|---|
   | Claude Code | Run `claude` in a terminal, then type `/login` |
   | Codex | Run `codex login` |
   | Cursor | Install the [Cursor CLI](https://cursor.com/cli), then run `agent login` |
   | Antigravity | Put Google's `agy_acp_server.exe` in `~/.malves/agents/antigravity/` and add `GEMINI_API_KEY` to `.env`. API key only, never your Google login |

### Step 3: Install malves on the computer

Open a terminal and run:

```sh
git clone https://github.com/LadsonDavid/Malves.git
cd Malves
corepack enable
pnpm install
pnpm build
cp .env.example .env
```

Open `.env` and set your name, so Malves knows what to call you:

```sh
MALVES_USER_NAME=YourName
```

Tell malves which project folder it may work in (you can add more later):

```sh
pnpm malves workspace add ~/code/my-project
```

Start it:

```sh
pnpm malves serve
```

A **QR code** appears. Leave this window open; you'll scan the code in step 5.

> **On Windows, start it automatically:** run `pnpm malves autostart on` once.
> From then on malves starts by itself every time you log in, with no window.
> To talk to it later (for example to get a new QR code), run
> `pnpm malves console pair`.

### Step 4: Install the app on your phone

1. Install **Tailscale** on your phone and sign in with the **same account** as
   on the computer.
2. Open `malves.apk` on your phone and allow installing from your browser or
   files app.

### Step 5: Pair the phone

Open malves on the phone, tap **Use the camera to scan**, and scan the QR code
from step 3.

The code lasts 2 minutes. If it expires, type `pair` in the `serve` window, or
run `pnpm malves console pair`.

Done. Home shows your computer as **Online**.

### Step 6: Turn on notifications (recommended)

So your phone can ask you questions while it's in your pocket:

1. Install the free **[ntfy](https://ntfy.sh)** app.
2. In malves, tap **Set up notifications**.
3. In ntfy, allow notifications and let it run in the background.

---

## Optional extras

Add only what you want. Each one is independent.

**Chrome (browser tasks).** Lets the agents and Malves read pages, open links,
and click or type for you after you say yes.
1. Unzip `malves-chrome.zip`.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder.
4. Type `extension` in the `serve` window (or run `pnpm malves console extension`),
   then paste the code it shows into the malves icon in Chrome.

**Your IDE (VS Code, Cursor, Antigravity, Windsurf).** Start the IDE's own agent
and open changes from your phone. In the IDE: **Extensions → ⋯ → Install from
VSIX…** and choose `malves.vsix`. Look for "malves" in the status bar.

**Malves, the assistant.** A voice you can talk to: "is Codex done?",
"start Claude on the footer bug", "read me the result". It needs:
- **A brain:** any OpenAI-compatible server. We use
  [freellmapi](https://github.com/tashfeenahmed/freellmapi) on a free Oracle
  Cloud VM.
- **A memory folder:** an Obsidian vault.

In `.env`:

```sh
MALVES_MODELS_URL=http://<your-server>:3001
MALVES_MODELS_KEY=...
MALVES_VAULT=C:\Notes\Malves
```

**Natural voice.** Malves sounds like a person instead of a robot. Add one or
more of these (each has a free tier):

```sh
CARTESIA_API_KEY=...
ELEVENLABS_API_KEY=...
MALVES_PIPER_URL=http://<your-server>:5005   # Piper on your own server
```

**Calls.** Malves rings your phone with a real call screen, for example when
you say "call me when Codex finishes". The release APK can't ring for you: calls
are tied to a Firebase project, so you build your own APK.
1. Create a free [Firebase](https://console.firebase.google.com) project, and add
   an Android app with the package name `io.github.ladsondavid.malves`.
2. Fork this repo. Add the contents of the Firebase `google-services.json` as a
   repository secret named `GOOGLE_SERVICES_JSON`, then run **Actions → Android
   APK → Run workflow** and install that APK.
3. In Firebase, go to **Project settings → Service accounts → Generate new
   private key**. Save the file outside the repo and set
   `MALVES_FCM_KEY=<path to it>` in `.env`.
4. Restart `serve`, then on the phone tap **Settings → Calls → Test call**.

**Leads.** Who to contact this week, from
[signalstack](https://github.com/LadsonDavid/signalstack). Set
`MALVES_LEADS_URL` in `.env`.

After changing `.env`, restart `serve`.

---

## How to use it

**Start a task.** Tap **New task**, write what you want ("fix the footer year"),
pick a folder and an agent, and tap **Start**. You can close the app; malves
keeps working.

**Answer questions.** When an agent wants to do something, like change a file
or run a command, your phone asks you. Tap **Allow** or **Skip**, from the app
or the notification. If nobody answers in time, the task stops. Silence never
means yes.

**Carry on an earlier session.** **Work → Sessions** lists your Claude Code,
Codex, Cursor and Antigravity sessions from the computer. Open one and type
what's next.

**Talk to Malves.** Tap the mic on Home, or the floating mic on any other
screen, and just say it: "what's running?", "stop this one", "why did it
fail?". Anything that changes something is read back first, and waits for your
yes.

**See and control your computer.** Tap **Your screen** to see live video of
your computer:
- Tap to click; hold to right-click.
- Switch to **Trackpad** to move the pointer by dragging.
- **Keyboard** lets you type and press keys.

The computer shows a notification whenever a phone is watching.

**Hand over your computer.** Leaving for a while? Say "I'm leaving, take over
my computer". Malves can then run tests and builds and use Chrome. Anything
else waits for your yes. It ends when you tap **Stop**, say "I'm back", or after
4 hours.

---

## If something doesn't work

| What you see | Try this |
|---|---|
| The phone says **Offline** | Check Tailscale is on, on **both** devices, and the computer is awake |
| The console says "serve is still starting" | Right after the computer starts, wait a minute and try again |
| An agent shows **Needs sign-in** | Sign in on the computer (step 2), then tap **Check again** in Settings |
| An agent shows **Slow to start** | That's fine: it works, it just takes a little longer to begin |
| The QR code expired | Type `pair` in `serve`, or run `pnpm malves console pair` |
| The call shows only as a notification | Tap **Settings → Calls → Not ringing?** and allow full-screen notifications for malves |
| Malves sounds robotic | Add a natural-voice key (above), and check **Settings → Voice → More voice options → Use the phone's voice** is off |

## Reference

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

malves is better with more people in it. You don't need to be an expert, and
you don't need to write code to help.

**Ways to help, from small to big:**

1. **Try it and tell us what broke.** Open an [issue](https://github.com/LadsonDavid/Malves/issues)
   with what you did, what you expected, and what happened. Screenshots help.
2. **Fix a word.** Typos, confusing sentences in this README or in the app: small
   pull requests are welcome.
3. **Pick up an issue.** Look for issues labelled `good first issue`. Comment on
   one before you start, so two people don't do the same work.
4. **Test on your device.** Most features still need real-world tests on different
   Android phones and Windows PCs. Telling us "it works on my phone" counts.
5. **Suggest an idea.** Open an issue that starts with "Idea:" and say what
   problem it solves for you.

**Before your first pull request:**

- Set up: `pnpm install`, then `pnpm typecheck`, `pnpm lint` and `pnpm test`
  must pass. See [Development](#development).
- Keep each pull request about one thing. Small is easier to review.
- Read the security model in [ARCHITECTURE.md §8](ARCHITECTURE.md#8-security)
  if your change touches what the phone can make the computer do. A phone that
  runs things on your desktop needs care first, a demo second.
- If you copy code from another project, add it to [THIRD-PARTY.md](THIRD-PARTY.md)
  with its licence.
- Say in your pull request that your contribution is your own work and can be
  released under the MIT licence.

**Why that last point matters:** malves started as a university final-year
project, so every outside contribution is credited by name, both here and in
the project's record of who wrote what. Thank you for helping.

Not sure where to start? Open an issue that says "I'd like to help with ___"
and we'll find something that fits.

## License

MIT. See [LICENSE](LICENSE). Borrowed code and designs are listed in
[THIRD-PARTY.md](THIRD-PARTY.md).
