# Architecture

Backend architecture for malves. Every decision here traces back to the seven
pain points in [idea.txt](idea.txt) and the requirements R1–R10 below.

---

## 0. Context

### The seven pain points

| # | Pain | Satisfied by |
|---|---|---|
| 1 | Lead gen costs $50+/month | signalstack, self-hosted |
| 2 | Can't carry the desktop everywhere | Android app ↔ desktop runner |
| 3 | Remote desktop is unusable on a phone | Structured events, not pixels: questions, results and decisions come to the phone, and Malves (voice) acts for you. A live, view-only screen only during handover |
| 4 | Remote control only works for Claude and Codex | ACP (~50 agents) + Cursor's CLI + Antigravity via API key + one companion extension for the desktop IDEs |
| 5 | Browser automation needs a paid subscription | Chrome extension + phone approval gate (§5) |
| 6 | Credits drain fast | freellmapi (your own keys) + budget guard + disk snapshots |
| 7 | Budget is low | Everything self-hosted; $0 required |

### Decisions already made

| Decision | Choice |
|---|---|
| Who uses a desktop's agents | **One owner per desktop.** No shared team accounts |
| Where the phone must work | **Anywhere, over mobile data** |
| Where the lead engine runs | **Either** the desktop or a cheap server — the user picks |
| Mobile platform | **Android only** for v1. iOS push must go through Apple's servers |

### Requirements (each one testable)

| # | Requirement | Pass if |
|---|---|---|
| R1 | Answer an agent question without opening the app | ≤ 2 taps, from the lock screen |
| R2 | Questions arrive quickly over mobile data | ≤ 10 s, desktop to phone |
| R3 | Nothing proceeds on silence | 0 actions after a question times out |
| R4 | Starting a task is quick | ≤ 3 steps: describe, pick computer and tool, go |
| R5 | Cross-platform (point 4) | Works with Claude Code, Codex, Cursor and Antigravity |
| R6 | Browser safety (point 5) | 0 submits, payments or logins without approval |
| R7 | Leads (point 1) | Weekly digest with a reason per company; $0 on desktop, ≤ $6/mo on server |
| R8 | Honest budget (point 6) | Shows which model answered; never silently switches to a weaker one |
| R9 | Low cost (point 7) | $0 required, ≤ $6/mo optional |
| R10 | Setup | ≤ 10 minutes, fresh machine to first task |

---

## 1. The overall shape

Two deployment topologies for reaching the computer. The user picks one at
setup; the desktop side is identical in both. Malves' brain lives on a small
free server either way, so the laptop does no model work.

```
 TOPOLOGY A — free ($0)                       TOPOLOGY B — with a relay (~$5/mo)

  Android app                                  Android app
     │ Tailscale (WireGuard), E2E sealed          │ WSS / TLS, E2E sealed
     ▼                                            ▼
 ┌──────────────── Desktop (runner) ────────────────┐   ┌──── VPS ─────────┐
 │ ACP/stdio ──▶ Claude Code · Codex · Antigravity · │   │ relay (blind)    │
 │               Cursor CLI                          │   └────────▲─────────┘
 │ Chrome extension ◀─ 127.0.0.1 (browser gate)      │            │ outbound only
 │ IDE companion extension ◀─ 127.0.0.1 (IDE bridge) │   (desktop identical)
 │ ntfy push · SQLite event log · git changes        │
 │ Malves: assistant, memory index, handover, voice ─┼──Tailscale──┐
 │ background supervisor (autostart) · console port  │             │
 └───────────────────────────────────────────────────┘             ▼
   memory: Obsidian vault on the desktop           ┌── Oracle free VM (ARM) ──┐
   backup: encrypted, nightly ───────── SSH ──────▶│ freellmapi (brain, Whisper│
                                                    │ vision, embeddings)       │
                                                    │ Piper (backup voice)      │
                                                    │ ~/malves-backups          │
                                                    └───────────────────────────┘
```

In topology B the desktop only *dials out* to the relay, so no ports are opened
on the home network.

**The runner is a single process with a microkernel design, not a set of
services.** Scalability is a non-goal — one user, one desktop — so there is
nothing to pay for distribution with.

---

## 2. Where ACP is used, and where it isn't

| Link | Protocol | Why |
|---|---|---|
| runner ↔ coding agent | **ACP over stdio** | The stable, fully specified part of ACP. ~50 agents for one integration |
| phone ↔ runner | **Our own small protocol** | ACP's remote transport is still work in progress, and the phone needs things ACP doesn't model: leads, budget, several computers. Happy and Runmote made the same choice |

---

## 3. Inside the runner

### Rules in the middle, tools on the outside

Dependencies point inward only. The core holds the rules and names **none** of
ACP, Chrome, freellmapi, Tailscale, the relay, ntfy or SQLite. Those sit
behind interfaces ("ports") that the core owns.

```
runner/
  core/                  ← the rules. May not import anything from adapters/
    tasks/               task lifecycle
    questions/           every human decision, of every kind
    budget/              quality floor and usage rules
    workspaces/          project folders registered on the desktop
    events/              append-only log and sequence numbers
  ports/                 interfaces the core owns:
                         AgentHost · BrowserTools · ModelMeter · PhoneLink · Notifier · Store
  adapters/
    acp/                 AgentHost (Cursor gets wrapped into ACP here)
    browser_gate/        BrowserTools: approval proxy in front of the Chrome extension
    budget_proxy/        ModelMeter: sits in front of freellmapi or your own key
    link_tailscale/  link_relay/
    push_ntfy/  sqlite/
  main                   the only place where core and adapters are wired together
```

**Boundary test:** tests for `core/` must run with fake ports — no agent, no
browser, no network. If a core test ever needs Chrome installed, a tool has
leaked into the rules.

### One Questions module for every human decision

Five things that look like separate features are the same thing — something
needs a person to decide:

- an agent asks a question
- an ACP permission request
- a browser action waiting for approval
- the free-model limit prompt ("pause, or use your own key?")
- approving a commit

All of them go through one deep module:

```
questions.ask({ task, text, choices, risk, timeout })  →  Answer | TimedOut
```

It hides saving the question, sending the push, encryption, delivery,
duplicate answers, rejecting stale answers, and the timeout rule: **on timeout,
stop — never carry on** (R3). Build it first and test it hardest.

### Task lifecycle

```
queued → running ⇄ waiting (on a question) → done | failed | stopped
```

"Computer offline" is *not* a task state. It is shown alongside, based on
heartbeats, so the phone never claims a task is running when it can't know.

### Continuing a conversation

A task is one turn of a conversation with an agent. When the agent opens its
session, the runner logs `task.session`, so the conversation can be continued:

- **Reply** on a finished task starts a new task in the same agent session,
  project and agent.
- **Continue an earlier one** lists the agent's saved conversations in that
  project (ACP `session/list`) — including ones started in the IDE or terminal —
  and the new task resumes the chosen one.

The runner uses `session/resume` where the agent offers it, else `session/load`,
whose replay of the past is dropped (the user has seen it). Claude, Codex and
Antigravity support both. Antigravity lists only conversations malves started,
because it runs with its own `GEMINI_HOME`.

**Limit:** ACP can't attach to a conversation that is *live* in another process.
Two writers would tangle it, so malves never runs two tasks in one
conversation, and the phone warns when the chosen one was used in the last
10 minutes ("close it on your computer first").

### Sessions across tools, and folders instead of projects

The phone's **Work → Sessions** lists every coding session on the computer,
newest first, read where each tool keeps them (read only):

| Tool | Where | Continue from the phone |
|---|---|---|
| Claude Code (terminal, desktop app, IDE extension) | `~/.claude/projects/*/*.jsonl` | resumed by Claude Code's agent |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | resumed by Codex's agent |
| Cursor editor chats | Cursor's `state.vscdb` (chats, messages, folders) | sent into the chat through Cursor's **Desktop Bridge** (Settings → Beta); without it, a new session told the story so far |
| Antigravity editor conversations | `~/.gemini/antigravity-ide/conversations/*.db` (protobuf, decoded by field path) | a **new** Antigravity session (API key) in the same folder, told the story so far; the editor's own agent API isn't driven (it runs on the Google login) |

Folders replace hand-added projects: the phone may start work in any folder
that appears in your own sessions or that was added on the computer, and it
becomes a project on first use. A brand-new folder still has to be added on the
computer (`malves console add <folder>`). The first full scan takes a few
seconds and runs in the background when `serve` starts; later scans re-read
only changed files.

### Reviewing and committing a task's changes

In a git project, the runner snapshots the uncommitted files (path and content
hash) as a task starts. When it ends, only files that differ from the snapshot
are the task's: they are logged (`task.changes`) and the user is asked
"Commit 3 changed files (+40 −12)?" — a `commit_approval` question, so it
also arrives as a notification. **View changes** shows the diff on the phone.
"Commit" commits only those files, with the task's first line as the message;
the user's own earlier edits are never included. No answer means no commit.

### Storage: an append-only event log

SQLite, append-only, with current state derived from the log — the same idea as
signalstack. It gives:

- **Resume after a dropout** — each event has a sequence number; the phone asks
  for everything after `#1042`
- **An audit log for free** — nothing is overwritten, so an incident can be
  reconstructed
- **History** for the phone's "Done today" list

---

## 4. The phone link

### Messages, in the user's vocabulary

```
phone → runner   hello{v, since_seq, wish}   task.create   answer{question_id, choice}
                 task.stop   agents.check   result.approve   computer.status
runner → phone   welcome{workspaces, agents}   agents{…}   ack{command_id}
                 event{seq, …}: task.updated · question.opened · question.closed
                 task.result · budget.updated · error
```

**Agent readiness.** At startup and on `agents.check`, the runner starts each
agent, opens a session with no work, and stops it — labelling it `ready`,
`needs_sign_in` (ACP `auth_required`) or `unavailable`. Real tasks keep the
labels current. The phone only offers ready agents, so a task never fails just
because nobody signed in; when one still does, the reason is a plain sentence
("Claude isn't signed in on your computer…"), not "Authentication required".

Each envelope is encrypted end to end, **inside** the TLS or WireGuard
connection, so the relay and the push service cannot read anything.

| Pattern | Where it's used |
|---|---|
| Version Identifier + Two in Production | `v` in `hello`; the runner serves the current and previous versions |
| Wish List | The phone subscribes only to what it needs — saves mobile data |
| Resume from a position | `since_seq` fetches only what's new after a dropout |
| Id Element | Every question, command and event has an id |
| Error Report | Errors are proper messages, not strings in a field |
| Pagination | History lists |

### Delivery guarantees

- **Runner → phone: at least once.** A dropout never loses a question. The phone
  removes duplicates by sequence number.
- **Phone → runner: at least once, applied once.** Each command carries a
  phone-generated id. **Answers apply once per question id — the first answer
  wins.** A late answer, or one to a timed-out question, gets `question.closed`
  and is ignored.
- **Presence:** heartbeat every 30 s. The phone shows "online" or "last seen 3
  min ago".
- **Reconnection:** capped exponential backoff with random jitter.

### Push: a hint, never the source of truth

```
runner (acting as a tiny ntfy server, on the Tailscale address only)
   ─▶ ntfy app on the phone (holds the connection, no Google, no ntfy.sh)
   ─▶ notification with up to three answer buttons, on the lock screen
tapping a button ─▶ POST to a one-time answer link on the runner ─▶ questions.answer
```

- The phone's ntfy app subscribes to a **secret topic** on the runner. The
  malves app carries the subscribe link inside the encrypted welcome, and
  "Set up notifications" opens ntfy with it (`ntfy://…`).
- Each button is a random, single-use answer link that dies when its question
  closes. When a question closes anywhere, the notification is removed
  (`message_delete`).
- **Revoking a phone makes a new topic.** Old subscriptions and every button
  already sent stop working; other phones set up notifications again.
- ntfy messages are plain JSON, so they are served **only on the Tailscale
  address**, where WireGuard encrypts them. Without Tailscale, notifications are
  off; the app still works.

**If a push is lost, nothing breaks** — opening the app resumes from the event
log.

*Why not UnifiedPush + `expo-unified-push` (the first plan):* that library
shows notifications without buttons, so R1 fails, and it needs a custom Android
build. Our own native module would fix both, but costs weeks of Kotlin. The ntfy
app already does buttons and background delivery well.

---

### Voice

The phone can be used by voice, in English (India or US) and Tamil:

- **Listening** uses Android's speech recognizer (`expo-speech-recognition`;
  APK only): words appear live, the agent and project names and the command
  words are passed as hints, and a low-confidence result is asked again.
- **Speaking** uses Expo Speech: questions, results, running tasks and leads
  are read aloud. Agent text is read in English; malves' own phrases follow the
  chosen language.
- **Commands** are fixed rules on the phone, not a model, so the same words
  always do the same thing ("allow", "option two", "ask Claude to … in
  <project>", "what's running", "read the result", "stop listening", and Tamil
  or Tanglish equivalents). Any "no" word makes an answer a no, so a mishearing
  can only deny.
- **Safety** follows the questions rules: silence answers nothing; high-risk
  answers, new tasks and stopping a task are read back and need "confirm" or
  "start".
- **Hands-free mode** reads each new question as it arrives and keeps
  listening until "stop listening" or two minutes of silence.
- **Precise dictation** (optional) records the prompt (Android 13+), sends it to
  the runner in pieces over the encrypted link, and the runner transcribes it
  with Whisper through freellmapi. The audio is kept in memory only until then.

### Malves, the assistant

When it's set up, what you say goes to **Malves**, an assistant that
understands loose speech, mixed English and Tamil, and missing context. The
fixed rules above stay as the fallback when it's off or unreachable.

- **Brain:** an OpenAI-compatible endpoint with tool calls — freellmapi on a
  free Oracle Cloud VM, reached over Tailscale, so it costs nothing and doesn't
  load the laptop (`MALVES_MODELS_URL`, `MALVES_MODELS_KEY`). The runner
  gives it the agents, projects, tasks, waiting questions and recalled
  memories; untrusted text (prompts, agent questions) is marked `<data>` and
  never treated as instructions.
- **The brain proposes, the code decides.** It can only call tools (start,
  stop, reply to and re-run tasks; answer questions; ask an IDE's agent; read
  tasks and leads; remember, recall, forget). The runner's policy then acts at
  once only on a "no", a low-risk answer, a lookup or a memory change.
  Everything else is held and **read back in words the code writes** (not the
  brain), and needs a yes — said, matched by fixed rules, or tapped on
  **Confirm**. A held action expires after three minutes. Silence answers
  nothing; the safety rules aren't something it can change.
- **Hearing:** Android's recognizer with up to four guesses, all sent to the
  brain. When Android isn't sure, the recording goes to Whisper on the
  computer for a second listen.
- **Speaking:** the phone's own voices (Indian English, Tamil; chosen in
  Settings). Replies in Tamil script are read in the Tamil voice.
- **Memory:** Markdown notes in an Obsidian vault (`MALVES_VAULT`, the source
  of truth: Facts, Preferences, People, Projects, Lessons, Skills) with an
  embeddings index in SQLite beside it. A note that says the same thing as a
  newer one is closed (`valid_to`), not deleted. Edits made in Obsidian are
  picked up; Settings → Malves' memory lists the notes and deletes any of them.
  Each day's conversation is logged in `Conversations/`.
- **Learning, with approval:** Malves can propose a *lesson* (what to do
  differently next time) or a *skill* (a named, reusable request). Each is read
  back and saved to `Lessons/` or `Skills/` only on a yes; approved ones come
  with every turn and can't override the rules or confirmations. Undo is
  deleting the note.
- **Watching:** when a task finishes or fails, a notification opens it
  (outside `MALVES_QUIET_HOURS`; questions always notify). In hands-free mode
  the phone also says it.
- **Look at this:** a photo from the phone camera (about 1280 px JPEG, sent in
  pieces over the encrypted link) goes to a vision model on freellmapi; what it
  saw joins the conversation as data, so text in the photo can't instruct it.
- **Backup:** about once a day the vault is packed, gzipped and encrypted on the
  laptop (AES-256-GCM, key in `backup.key`, never uploaded) and streamed over
  SSH to `~/malves-backups` on the server; the 14 newest are kept.
  `malves backup restore` opens one into a new folder, never over the vault.
- **Handover mode** ("I'm leaving, take over"): starts only on a yes. While
  it's on, Malves may run commands in registered project folders and use Chrome
  through the extension. Reading commands and tests/builds/lint run by
  themselves; anything else (and anything chained, piped, redirected or using
  variables) is read back and waits for a yes. Chrome: reading the page is
  free, opening, clicking, typing and pressing keys ask; password and payment
  fields are refused, checked on the live page. It ends only on the phone's Stop,
  "I'm back", or after four hours (not when he touches the computer: he may be
  at the desk watching it work), and the phone is told. While it's on, the
  phone can watch the screen live: view only, a 1000 px JPEG (~50 KB) about
  once a second, not kept by the link's command cache.
  **Desktop (Windows):** mouse, keyboard and screen through nut.js (the
  community fork), loaded when handover starts. Looking at the screen is free:
  a screenshot, resized to the mouse's logical pixels, goes to a vision model.
  Clicking, typing and keys are read back with the window's title and the
  coordinates, and are done only if the same window is still in front at the
  yes. In code editors Malves works as a co-developer (owner's choice, Oct
  2026); the read-back warns that a click there may accept or reject the
  editor AI's change, so those approvals still come to the phone. Never in
  sign-in, password, payment or admin windows.
  (A PowerShell helper for this was blocked by Windows Defender as malicious;
  we don't work around antivirus.)

### Desktop IDEs

malves runs the agents' headless forms (ACP over stdio). The desktop IDEs —
VS Code, Cursor, Antigravity, Windsurf, all VS Code forks — are reached by one
companion extension (`packages/ide`, installed from `malves.vsix`) through
**public extension APIs only**:

- It connects to the runner on `127.0.0.1:7721` with a secret it reads from the
  malves data folder (same user, no setup). Requests with an Origin header —
  web pages — are refused.
- The phone sees which IDE windows are open and which projects they show
  (names only, no paths), and can: start the IDE's own agent (VS Code:
  `workbench.action.chat.open` in agent mode; Cursor: its documented prompt
  deeplink, which only pre-fills — Enter is pressed at the desk; others say
  they can't); open a task's changed files as diffs; and reopen a Claude Code /
  Codex conversation in the IDE's terminal (`claude --resume <id>`, ids
  restricted to safe characters, and the extension only types commands of
  that exact shape).
- Agent questions also show in the IDE with answer buttons (first answer wins,
  as everywhere).
- **Hand-off:** Claude Code's and Codex's IDE extensions share their
  conversations with the CLI, so malves lists them per project and continues
  them from the phone (session/resume), or reopens them at the desk.

**Limit:** through the extension, the IDE's own agent panel (its approvals, its
replies) can't be driven: there's no public API for it. In handover mode Malves
can use the editor on screen like a co-developer (see "Malves, the assistant"),
with every click and keystroke read back to the phone first.

## 5. Browser tasks: a Chrome extension, like Claude in Chrome

**Owner's decisions (2026-10-02):** work like Claude in Chrome — in the user's
real, logged-in Chrome, on **whatever tab is open**, with the browser tools
**available to every task**. This replaces the earlier Playwright design.

```
agent ──MCP over HTTP──▶ runner: browser gate ──WS 127.0.0.1:7718──▶ Chrome extension ──▶ open tab
        (per-task URL)       │ asks the phone                (extension origin + code)
                             ▼
                      tasks.ask → questions.ask (silence stops the task, R3)
```

- **Tools** (`adapters/browser/tools.ts`): `browser_snapshot`, `_navigate`,
  `_click`, `_type`, `_select`, `_press`, `_scroll`, `_back`. Served as an MCP
  server on 127.0.0.1, one unguessable URL per task, passed to the agent in ACP
  `session/new` (`mcpServers`, HTTP — supported by Claude, Codex and
  Antigravity). DNS-rebinding protection on; URLs die with the task.
- **Bridge** (`adapters/browser/bridge.ts`): the extension connects to
  `ws://127.0.0.1:7718` and must come from a `chrome-extension://` origin
  **and** present the code from `malves serve` → `extension`. A web page can
  open a socket to 127.0.0.1 but can't fake that origin.
- **Extension** (`packages/extension`, MV3, loaded unpacked — not published):
  all logic is bundled; the runner sends only operation names and arguments, so
  there is no remote code.

The gate enforces rules **in the tool**, independent of the agent:

| Action | Rule |
|---|---|
| first use of a site in a task (reading too — it's the logged-in browser) | asks the phone (R6) |
| click, type, choose, press Enter | asks the phone, naming the element (R6) |
| password, card, CVC, one-time-code fields | **refused** in the page itself; their values are never read |
| unanswered question | the task stops (R3) |

The agent's own generic "allow this tool?" prompt is skipped for these tools
only, since the gate already asks a more specific question.

**Known limits:** element labels come from the web page, so a hostile page can
word its own buttons misleadingly (they are clipped to one short line before
reaching the phone). A logged-in browser means an agent can act as the user —
the phone approval is the real safety net, which is why nothing that changes a
page goes through without it.

---

## 6. Budget guard

A local endpoint on `127.0.0.1` speaking the OpenAI-compatible API. Agents point
at it; it forwards to freellmapi or to your own key. It adds three things:

1. Records which model actually answered, and how many tokens were used.
2. Enforces the quality floor — tasks that write code may only use an allowed
   list of models.
3. When the floor would be broken, calls `questions.ask("Pause, or use your own
   key?")` instead of silently downgrading (R8).

**Built:** with `MALVES_MODELS_URL` (freellmapi) and `MALVES_MODELS_KEY` set,
two more agents appear: **Claude (free models)** and **Codex (free models)** —
the same agents, with their model calls sent to the guard (Claude Code through
`ANTHROPIC_BASE_URL`, Codex through its own provider config). Each task gets its
own guard URL, so usage counts per task and dies with it, and the real
freellmapi key never reaches the agent.

- `X-Routed-Via` names the model before the answer is passed on, so a model
  outside `MALVES_MODELS_ALLOW` is held back while the phone asks "Use it" or
  "Stop the task" (once per model per task). Silence stops the task (R3).
- The first model and every switch are logged (`task.model`); tokens are logged
  when the task ends (`task.usage`). The phone shows "via A → B · 12k tokens".
- A `429` from freellmapi (free quota used up) stops the task with a plain
  reason; malves never moves it to another model by itself.

**Limit:** agents running on your own Claude, Codex or Cursor subscription bypass
the guard and aren't metered; the phone shows no model line for them.

---

## 7. The lead engine reaches the phone through the runner

The runner never imports signalstack: it stays a separate Python process,
reached over HTTP, on this computer or on a server (owner's choice).

- `malves serve --leads <url>` (or `MALVES_LEADS_URL`) points the runner at
  signalstack. Its `UI_KEY`, if set, comes from `MALVES_LEADS_KEY` and is sent
  as an `x-key` header, never in the URL.
- The phone sends `leads.refresh`; the runner fetches `GET /api/leads`, checks
  the answer against the `Lead` schema, and sends a `leads` message to every
  paired phone over the existing encrypted link. Leads are not written to the
  event log — they are signalstack's data, and refreshing gets them again.
- So the phone pairs once, with the runner: no second endpoint, no second
  pairing, and lead traffic is end-to-end encrypted like everything else.
- "Research in browser" starts an ordinary task whose prompt asks the agent to
  read the company's site with the browser tools (§5), which ask before opening
  it. Lead text comes from public posts, so the prompt marks it as notes, not
  instructions.
- The weekly digest push carries **counts only** ("12 companies this week"), no
  names.

**Trade-off:** leads need the computer to be on. Accepted — every task needs
that too, and it keeps one pairing and one encrypted channel.

---

## 8. Security

Threat model: others on the same wifi, internet scanners, a lost phone, web
pages and agent output trying to steer Malves (prompt injection), and the
computer's own antivirus.

| Control | How |
|---|---|
| Pairing | QR carries the runner's public key, a 120 s one-time secret, and how to reach it. Phone makes its own key pair; public keys are swapped; every message then uses NaCl `box`. Adapted from Happy |
| Least privilege | Tasks run only in folders the desktop knows. Outside handover the phone has no shell. In handover, commands run only in project folders: reading and tests/builds run alone; anything else, anything chained/bracketed/quoted, anything outside the project or touching secrets (`.env`, keys) is read back for a yes |
| Malves | The brain proposes tool calls; runner code decides. Risky actions are read back in words the code writes, and the yes is matched by rules, never by the model. Text from agents, pages, photos and screens is marked as data. Memories it thought of itself, lessons, skills and forgetting all need a yes |
| Desktop control (handover) | nut.js; every click/keystroke read back with the window's title, done only if the same window is still in front; never in sign-in, password, payment or admin windows. Editors allowed (owner's choice), with a warning that a click may accept the editor AI's change |
| Local ports | Chrome bridge, IDE bridge and `malves console` listen on 127.0.0.1 only, each with its own secret from the data folder, and refuse requests with an Origin header (web pages) |
| Nothing built from strings | Every process starts from an argument list, enforced by the type the core hands out (handover's shell is the one deliberate exception, behind the rules above) |
| Workspace confinement | In ACP the client provides file and terminal access, so the runner confines those requests to the workspace |
| Blast radius | Per-device revocable keys; handover ends on Stop, "I'm back" or after 4 h |
| Breakglass | "Stop all" on the phone, or `malves console stop` on the desktop, always wins |
| Secrets | Phone: Android Keystore. Desktop: owner-only files in the data folder (see §15 deviation); API keys in `.env`, never committed |
| Backups | The vault is encrypted on the laptop (AES-256-GCM) before it leaves; the key never leaves |
| Antigravity | API key only, never a consumer Google login: the IDE's internal agent API is not driven, because it runs on the Google login |
| Antivirus | Never worked around. A PowerShell desktop helper Defender flagged was dropped for nut.js |

**Known limit:** agent processes run with the user's normal permissions, and
some agents read the disk directly rather than through ACP, so workspace
confinement is partial. Full isolation needs containers — out of scope.

---

## 9. Failure handling

| Outside piece | Protection | What the user sees |
|---|---|---|
| Agent process | one process per task; activity timeout | task failed, with a clear error |
| Chrome extension | separate connection; call timeouts | browser task failed, coding tasks unaffected |
| Malves' brain (freellmapi) | timeouts; the phone falls back to fixed voice rules | "My brain isn't reachable", rules still work |
| Natural voice | Cartesia → ElevenLabs → Piper on the server → the phone's voice | Malves says once when it steps down |
| `malves serve` crash | the background supervisor restarts it (5 quick crashes: gives up) | phone reconnects by itself |
| freellmapi | timeout; on running out, ask via questions | the pause-or-own-key prompt |
| Link (Tailscale or relay) | backoff with jitter; resume from sequence number | "last seen…", then catches up |
| ntfy app | it reconnects and catches up on open questions; failure is harmless | inbox correct when the app opens |
| signalstack | fully independent | leads shown with an "as of" timestamp |
| Unanswered question | timeout, then **stop** | "Stopped waiting. Nothing changed after the question." |

---

## 10. Architecture decision records

| # | Decision |
|---|---|
| 1 | Single-process microkernel runner, not services |
| 2 | ACP between runner and agents; our own small protocol between phone and runner |
| 3 | **Decided:** TypeScript runner, relay and Expo Android app; signalstack stays in Python behind HTTP. ACP's only official SDK is TypeScript, Happy is a TypeScript/Expo monorepo, and one language lets phone and runner share protocol and encryption code. See §15 |
| 4 | SQLite append-only event log |
| 5 | End-to-end encryption with libsodium, adapted from Happy |
| 6 | Push through the ntfy app, served by the runner over Tailscale, with one-time answer buttons; push is only a hint (§4) |
| 7 | Two deployment topologies |
| 8 | Browser tasks through the same questions pipeline, via the gate |
| 9 | Budget guard with a quality floor |
| 10 | Malves, the assistant: a hosted brain proposes tool calls; runner code decides, reads risky actions back in its own words and needs a yes; memory is an Obsidian vault |
| 11 | Desktop IDEs through one companion extension using public extension APIs |
| 12 | `serve` runs in the background at login (supervisor, no window); `malves console` replaces the terminal |
| 13 | Handover mode: shell, Chrome and screen, low-risk alone and the rest read back; ends only on Stop, "I'm back" or 4 h; a view-only live screen on the phone |
| 14 | Desktop control through nut.js; never work around antivirus |
| 15 | Voice: natural cloud voices with a self-hosted backup (Piper) and the phone's voice last; Tamil at every level |

---

## 11. Borrowed components

| Piece | Source | Licence |
|---|---|---|
| Encryption, pairing, encrypted push, relay server | Happy (`slopus/happy`) | MIT |
| ACP bridging and agent detection | Runmote | MIT |
| ACP client | official ACP TypeScript library | Apache-2.0 |
| Browser tools | Our own Chrome extension, served to agents with the official MCP SDK | MIT (MCP SDK) |
| Model gateway | freellmapi | MIT |
| Desktop control | nut.js (community fork) | Apache-2.0 |
| Icons, fonts | Heroicons; Geist, Geist Mono, Fraunces | MIT; OFL 1.1 |
| Backup voice | Piper + Tamil voices (Jeyaram-K) + official English voices | MIT / Apache-2.0 (per voice) |

Every row goes in `THIRD-PARTY.md` and in the dissertation's declaration of
original work. Run ntfy as a separate service and check its licence before
bundling anything from it.

---

## 12. Requirement traceability

| Req | Met by |
|---|---|
| R1 | encrypted push → notification buttons → `answer` |
| R2 | ntfy push; measured on mobile data |
| R3 | timeout inside `questions.ask` |
| R4 | `task.create` with workspace and tool pickers |
| R5 | ACP + Cursor wrapper + Antigravity via API key |
| R6 | browser gate |
| R7 | signalstack as a separate endpoint + digest push |
| R8 | budget guard |
| R9 | topology A costs $0 |
| R10 | QR pairing + automatic tool detection |

---

## 13. Build order

Each step ends in something demoable:

1. Core + fake ports + SQLite log, driving one ACP agent locally, questions in
   the terminal. Proves the questions module.
2. Tailscale link, pairing, encryption, minimal app with inbox and answer
   buttons. **Built:** `malves serve`, link protocol, QR pairing, revocation,
   resume, Expo app (pair / home / new task). Tested on a real phone.
3. Push through ntfy. R1 and R2 become measurable. **Built** (§4) with the ntfy
   app; awaiting a test on a real phone (lock screen, Doze, mobile data).
4. Cursor wrapper and Antigravity. R5. **Antigravity built:** Google's official
   `agy_acp_server` (installed under the data folder, signature checked), own
   `GEMINI_HOME`, API-key sign-in only. **Cursor:** speaks ACP natively
   (`agent acp`); profile built — found as a real program on PATH or in
   ~/.local/bin (never a `.cmd`). Awaiting a test once the CLI is installed.
5. Browser gate. R6. **Built** as a Chrome extension (§5); awaiting a real test.
6. Budget guard. R8. **Built** (§6): Claude and Codex on free models through
   the guard; awaiting a test against a real freellmapi.
7. Relay for topology B. **Built:** `packages/relay` — the computer keeps one
   outbound control connection (`MALVES_RELAY_TOKEN`); for each phone the relay
   says "incoming" and the computer opens a connection that the link server
   adopts like a direct one. Frames and close codes pass unchanged. Limit:
   notifications still need Tailscale.
8. Lead engine endpoint. R7. **Built** (§7): signalstack `GET /api/leads`,
   `malves serve --leads <url>`, the app's Leads screen with "Research in
   browser". Awaiting a test against real signalstack data.
9. Voice (English India/US, Tamil), hands-free, Whisper dictation. **Built.**
10. Desktop IDE companion extension. **Built;** connects in VS Code and
    Antigravity.
11. Malves, the assistant: brain on freellmapi, Obsidian memory, Confirm/Cancel,
    lessons/skills, task notifications, "look at this", encrypted backup,
    handover with live screen. **Built;** runner side and
    backup tested live, phone side being tested.
12. App redesign on the Malveon blueprint system (DESIGN.md). **Built.**
13. Background autostart + `malves console`. **Built,** running on the owner's PC.
14. Sessions across Claude Code, Codex, Cursor and Antigravity; folders replace
    hand-registered projects. **Built.**
15. Natural voice: the brain's reply streams and is spoken a sentence at a time
    (Cartesia → ElevenLabs → Piper → the phone's voice), Tamil and English voices
    picked in Settings, and talking over Malves stops it. **Built;** runner side
    tested live, phone side awaiting a real test.

### How Malves speaks

1. The brain's reply streams from freellmapi; the runner cuts it into sentences
   as they complete. Once the model starts proposing a tool call, its words stop
   being passed on: what will be done is read back in code-written words.
2. Each sentence goes, one at a time and in order, to Cartesia (sonic-3.6), then
   ElevenLabs (Flash v2.5), then Piper on the Oracle server (tailnet only). Tamil
   script is read by the Tamil voice, English and Tanglish by the English one.
   A provider that answers "out of credit" is skipped until next month
   (`~/.malves/voice-credits.json`), and the phone is told once.
3. Each sentence is its own `assistant.audio` clip (in pieces of 128 KB, under
   the relay's 256 KB frame). A sentence no voice could say goes as text, and
   the phone reads it itself. A last message marks the end.
4. The phone picks the command id itself, so it starts playing the first
   sentence before the reply's ack arrives.
5. Talking over Malves: while it speaks, the phone's recognizer listens. Android
   gives no echo cancelling for this, so Malves' own words are ignored; a stop
   word ("stop", "wait", "nillu", "போதும்"…) or three words that are mostly not
   Malves' stop it, and it listens. Settings can turn this off.

16. His profile, his skill library, his screen from the phone, and Malves
    calling him (Oct 8). **Built;** awaiting real-world tests.

### His profile ("About me")

- `About me.md` in the vault holds the **work** profile only. The private one
  stays on the computer and is never sent: the brain runs on free providers,
  some of which keep or train on prompts.
- Its core sections (priority, identity, voice, decision rules, do-not-infer;
  about 1,200 tokens) go with every message; all of it for writing requests.
- Malves never edits it on its own. `update_profile` (when he corrects it) and
  the weekly check (the profile against the week's conversations and tasks)
  only draft edits. Code checks each matches exactly once and keeps the
  sections, reads it back in code-written words, and writes on yes; a no drops
  a draft.

### His skill library

`~/.claude/skills` is read, never changed. Each skill's description is embedded
once (again only when it changes, cached in `skill-index.json`). Similarity alone
can't tell a command from a question (bge-m3 scores both 0.45-0.57), so the five
closest are only *offered* to the brain by name; it reads one (`read_skill`) for
advice, reviews or judgments, as data it must never act on. The phone shows
"From your library: …". Routers and Claude Code workflows are left out.

### His screen from the phone

Any time, not only in handover: about three pictures a second on a 1080p screen
(the next one captured while the last travels), and in Control a tap clicks
there (as a fraction of the screen, so display scaling doesn't matter), plus
double/right click, scroll, typing and keys. No read-backs: he decides each
click. The computer shows a Windows notification when a phone starts watching or
takes control. No fingerprint gate (his choice).

### Malves calling him

1. He asks ("call me when Codex finishes"): `call_me` watches the task; when it
   ends, the call's opening line is written by code from the task's outcome.
2. The runner sends a Firebase (FCM HTTP v1) data push with **no content**, only a
   call id, signed with his project's service-account key (`MALVES_FCM_KEY`).
3. The phone wakes (an expo-notifications background task, even if the app was
   closed) and shows Android's incoming-call screen
   (react-native-full-screen-notification-incoming-call).
4. On Answer, malves opens and asks over the sealed link why it called
   (`call.answer`); Malves says it in its natural voice and the conversation goes
   on hands-free.
5. Rules: none in quiet hours, at most three an hour, none after "don't call me
   today", a call answered after ten minutes is over, revoked phones are never
   rung. Settings has a test call.

Calls use Google's push because a ringing call screen needs the app itself to
be woken; everything else stays on ntfy. Android 14+ may need "Full screen
notifications" allowed for malves (Settings links there).

---

## 14. To verify before relying on it

Checked:
- ~~Topology A needs Tailscale on the phone.~~ Set up; the phone reaches the
  runner over mobile data.
- ~~Android blocks plain `ws://` outside Expo Go.~~ The APK sets
  `usesCleartextTraffic`; payloads are end-to-end sealed anyway. The APK is
  built by `.github/workflows/apk.yml` and installed on the owner's phone.
- ~~ntfy delivers questions with answer buttons.~~ Worked on the real phone.
- ~~Claude Code speaks Anthropic's format through the budget guard.~~ The guard
  passes it through.

Still open:
- **Cursor headless questions:** the CLI isn't installed yet; whether it asks
  questions or runs on a fixed policy shapes what R5 can claim.
- **Antigravity session reload:** the official ACP server (1.2.1, Windows) has a
  reported bug where reloading a session replays no history.
- **Cursor Desktop Bridge** is Beta and server-gated; check it's available on
  the owner's account before relying on it.
- **Vision pointing:** the free vision models describe screens well but give
  imprecise click coordinates; clicks are always read back.
- **Free voice credits** (Cartesia, ElevenLabs) cover part of a month at
  "always natural"; the backup voice covers the rest.
- **Doze mode** delays on a locked phone over hours (R1, R2), measured over a
  few days of real use.

---

## 15. Tech stack

TypeScript everywhere except signalstack (Python). Two languages in total.

### Repo layout — pnpm monorepo

```
packages/
  protocol/   message schemas, envelope encryption, versions   ← shared by all
  core/       tasks · questions · budget · workspaces · events ← depends only on protocol
  runner/     adapters + wiring (ACP, Chrome bridge, IDE bridge, budget proxy, link, push, SQLite, assistant)
  relay/      blind WebSocket forwarder, topology B only
  app/        Expo Android app                                  ← depends on protocol
  extension/  Chrome extension (MV3, unpacked): the browser tools
  ide/        VS Code-fork companion extension (malves.vsix)
```

- `core` as its own package means the package manager enforces the Dependency
  Rule: it cannot import ACP, Chrome or nut.js because they aren't its dependencies.
- `protocol` is shared, so phone and runner use the same message definitions and
  encryption code.

### By layer

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript on Node.js (current LTS) | Official ACP SDK; reuse Happy; one language across runner, relay, app |
| Agents | `@agentclientprotocol/sdk` | Official, includes the client side |
| Agent adapters | `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` as pinned dependencies | Started as `node <their script>`, never `npx` — on Windows `npx` is `npx.cmd`, which can't start without a shell |
| Message validation | `zod`, in `protocol` | Everything from the phone is checked at the trust boundary |
| Encryption | `tweetnacl` + `tweetnacl-util`, in `protocol` | NaCl `box`, same design as Happy (our own code); pure JS, runs on desktop and phone. The app supplies randomness via `setRandomSource` + `expo-crypto` |
| Storage | SQLite via `better-sqlite3`, **pinned to 12.11.1** | Proven, synchronous, single file — fits an append-only log. 13.x ships no Windows builds; check before upgrading |
| Processes | Node `child_process.spawn` with argument arrays | No library; never builds commands from strings |
| Secrets | Phone: `expo-secure-store` (Android Keystore). Runner: `runner-key.json` in the data folder, owner-only | **Deviation:** the OS keychain needs native modules and a desktop session CI can't provide. A process that can read the file can already run the agents directly. Revisit if the local threat model grows |
| Browser | Chrome extension (`packages/extension`, MV3, unpacked) | Owner chose Claude-in-Chrome style: real logged-in Chrome, current tab |
| Browser gate | `@modelcontextprotocol/sdk` 1.31 (stateless HTTP) + `ws` bridge | Official MCP SDK; tools served to agents, gate inside each tool |
| Budget guard | Node built-in `http` + `fetch` | Two routes; no framework |
| Phone link | `ws` 8.22 (server); the standard `WebSocket` API in the shared `LinkClient` | One client for the app and the tests. Default port 7717; the runner listens on its Tailscale address if it has one |
| Relay (B) | Node + `ws` in Docker, Caddy for HTTPS | Small blind forwarder; automatic certificates |
| Push | The ntfy Android app; the runner speaks ntfy's subscribe API itself | No extra server, no Google; Tailscale only |
| App | Expo **SDK 57** (React Native 0.86) + TypeScript | Shares `protocol` (via its built `dist`); state is a pure reducer over the event stream |
| App modules | `expo-camera`, `expo-secure-store`, `expo-crypto`, `expo-speech`, `expo-speech-recognition`, `expo-audio`, `expo-file-system`, `expo-font`, `react-native-svg` + Heroicons | QR and photos, Android Keystore, secure random, voice in and out, fonts and icons |
| Assistant | freellmapi (OpenAI-compatible chat, tools, embeddings, Whisper, vision) on an Oracle free VM; Obsidian vault + SQLite index | No model work on the laptop; memory the owner can read and edit |
| Desktop control | `@nut-tree-fork/nut-js`, loaded only in handover | Mouse, keyboard, screenshots; no PowerShell helper (Defender) |
| Voices | Cartesia, ElevenLabs (cloud, free tiers); Piper on the VM; the phone's own | Natural first, always a free fallback, Tamil at every level |
| Pairing QR | `qrcode-terminal` | QR shown in the desktop terminal |
| Models | freellmapi | OpenAI-compatible, your own keys |
| Leads | signalstack + one JSON endpoint (`/api/leads`) | Reached through the runner (§7); add a notifier to its scheduler |
| Remote access (A) | Tailscale (free personal plan) | Handles NAT; nothing to host |
| Testing | Vitest | Core tests run on fake ports |
| Lint/format | Biome | One tool |
| CI | GitHub Actions, Ubuntu **and Windows** × Node 22 and 24 | Type-check, lint, test (APK build later); free for public repos |

**Total cost: $0.**

### Left out of v1

- **Desktop tray app** — "stop everything" is Stop all on the phone or `malves console stop`.
- **App state library** — React's own state is enough.
- **Navigation library (Expo Router)** — four tabs and a small stack of screens
  (new task, task) are plain React state, with Android's back button handled.
- **Runner web framework** — two local routes don't need one.

### Check before committing

- ~~`expo-unified-push` maintenance.~~ Checked: no answer buttons, one
  maintainer. Replaced by the ntfy app (§4), so Expo Go still works.
- ~~`tweetnacl` needs a secure random source on React Native.~~ Done: `index.ts`
  calls `setRandomSource` with `expo-crypto` before anything else.
