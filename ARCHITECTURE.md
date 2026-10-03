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
| 3 | Remote desktop is unusable on a phone | Structured events, not pixels. No cursor, no screen mirroring |
| 4 | Remote control only works for Claude and Codex | ACP (~50 agents) + a Cursor wrapper + Antigravity via API key |
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

Two deployment topologies. The user picks one at setup; the desktop side is
identical in both.

```
 TOPOLOGY A — free ($0)                     TOPOLOGY B — with a server (~$5/mo)

  Android app                                Android app
     │ Tailscale (WireGuard)                    │ WSS / TLS
     ▼                                          ▼
 ┌────────────── Desktop ──────────────┐   ┌─────────── VPS ───────────┐
 │ runner ──ACP/stdio──▶ coding agents │   │ relay   (blind pipe)      │
 │   ├─ budget guard ──▶ freellmapi    │   │ ntfy    (push)            │
 │   ├─ gated browser ─▶ Playwright    │   │ signalstack (optional)    │
 │   └─ SQLite event log               │   └────────────▲──────────────┘
 │ signalstack (optional)              │                │ outbound WSS only
 └─────────────────────────────────────┘   ┌────────────┴── Desktop ───┐
  push via ntfy.sh — ciphertext only       │ runner … (identical)      │
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
ACP, Playwright, freellmapi, Tailscale, the relay, ntfy or SQLite. Those sit
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
    browser_gate/        BrowserTools: approval proxy in front of Playwright
    budget_proxy/        ModelMeter: sits in front of freellmapi or your own key
    link_tailscale/  link_relay/
    push_ntfy/  sqlite/
  main                   the only place where core and adapters are wired together
```

**Boundary test:** tests for `core/` must run with fake ports — no agent, no
browser, no network. If a core test ever needs Playwright installed, a tool has
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
runner ─(encrypted payload)─▶ ntfy ─▶ UnifiedPush on the phone ─▶ app decrypts
                                        ─▶ notification with [Existing] [New] buttons
tapping a button ─▶ answer is sent over the link (Tailscale or relay)
```

The push service only sees ciphertext (public ntfy.sh in A, your own ntfy in
B). **If a push is lost, nothing breaks** — opening the app resumes from the
event log.

---

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

**Limit:** agents running on your own Claude or Cursor subscription bypass the
guard. The budget screen says "via your Claude subscription — not metered".

---

## 7. The lead engine is a separate endpoint

The runner never depends on signalstack.

- The phone pairs with the lead engine as its own endpoint — over Tailscale in
  A, or through a relay route in B.
- "Research in browser" works by the phone passing lead details into
  `task.create`. The phone carries data between the two systems.
- The weekly digest push carries **counts only** ("12 companies this week"), no
  names.

**Trade-off:** in topology B the relay can read lead traffic. Acceptable — the
relay is your own server and the data is from public sources. End-to-end
encryption is kept for the code path.

---

## 8. Security

Threat model: others on the same wifi, internet scanners, a lost phone.

| Control | How |
|---|---|
| Pairing | QR carries the runner's public key, a 120 s one-time secret, and how to reach it. Phone makes its own key pair; public keys are swapped; every message then uses libsodium `box`. Adapted from Happy |
| Least privilege | The phone can only create tasks in workspaces **registered on the desktop**. Folders can't be added from the phone. No raw shell command |
| Nothing built from strings | Every process starts from an argument list, enforced by the type the core hands out |
| Workspace confinement | In ACP the client provides file and terminal access, so the runner confines those requests to the workspace |
| Blast radius | Per-device revocable keys; tokens scoped per workspace |
| Breakglass | "Stop everything" from the desktop tray always wins |
| Secrets | OS keychain, never files |
| Antigravity | API key only, never a consumer Google login |

**Known limit:** agent processes run with the user's normal permissions, and
some agents read the disk directly rather than through ACP, so workspace
confinement is partial. Full isolation needs containers — out of scope.

---

## 9. Failure handling

| Outside piece | Protection | What the user sees |
|---|---|---|
| Agent process | one process per task; activity timeout | task failed, with a clear error |
| Playwright | separate process; navigation timeouts | browser task failed, coding tasks unaffected |
| freellmapi | timeout; on running out, ask via questions | the pause-or-own-key prompt |
| Link (Tailscale or relay) | backoff with jitter; resume from sequence number | "last seen…", then catches up |
| ntfy | retry; failure is harmless | inbox correct when the app opens |
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
| 6 | Push through UnifiedPush and ntfy, encrypted payloads; push is only a hint |
| 7 | Two deployment topologies |
| 8 | Browser tasks through the same questions pipeline, via the gate |
| 9 | Budget guard with a quality floor |

---

## 11. Borrowed components

| Piece | Source | Licence |
|---|---|---|
| Encryption, pairing, encrypted push, relay server | Happy (`slopus/happy`) | MIT |
| ACP bridging and agent detection | Runmote | MIT |
| ACP client | official ACP TypeScript library | Apache-2.0 |
| Browser tools | Playwright MCP | Apache-2.0 |
| Model gateway | freellmapi | MIT |

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
   resume, Expo app (pair / home / new task). Awaiting a test on a real phone.
3. Push through ntfy. R1 and R2 become measurable.
4. Cursor wrapper and Antigravity. R5. **Antigravity built:** Google's official
   `agy_acp_server` (installed under the data folder, signature checked), own
   `GEMINI_HOME`, API-key sign-in only. **Cursor:** speaks ACP natively
   (`agent acp`); waiting for the CLI to be installed.
5. Browser gate. R6. **Built** as a Chrome extension (§5); awaiting a real test.
6. Budget guard. R8.
7. Relay for topology B.
8. Lead engine endpoint. R7.

---

## 14. To verify before relying on it

- **Cursor headless mode may not ask questions interactively** — it may run
  under a fixed allow/deny policy. If so, the Cursor wrapper supports "run, then
  approve the result". Test in week 1; it shapes what R5 can claim.
- **Claude Code uses Anthropic's API format**, so the budget guard must
  translate or pass it through. Subscription users bypass it entirely.
- **Android Doze mode** must still deliver high-priority UnifiedPush messages
  with action buttons. Test on a real phone.
- **Topology A needs Tailscale switched on** on the phone — a setup step that
  counts against R10.
- **Android blocks plain `ws://` outside Expo Go.** Expo Go allows it, so step 2
  works there. The step 3 development build must allow cleartext to the runner
  (or use `wss://`). Payloads are end-to-end encrypted either way, so this is a
  platform rule, not a security gap.

---

## 15. Tech stack

TypeScript everywhere except signalstack (Python). Two languages in total.

### Repo layout — pnpm monorepo

```
packages/
  protocol/   message schemas, envelope encryption, versions   ← shared by all
  core/       tasks · questions · budget · workspaces · events ← depends only on protocol
  runner/     adapters + wiring (ACP, Playwright, budget proxy, link, push, SQLite)
  relay/      blind WebSocket forwarder, topology B only
  app/        Expo Android app                                  ← depends on protocol
```

- `core` as its own package means the package manager enforces the Dependency
  Rule: it cannot import ACP or Playwright because they aren't its dependencies.
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
| Push | ntfy (ntfy.sh in A, self-hosted in B) + `expo-unified-push` | Self-hostable; payload encrypted |
| App | Expo **SDK 57** (React Native 0.86) + TypeScript | Shares `protocol` (via its built `dist`); state is a pure reducer over the event stream |
| App modules | `expo-camera`, `expo-secure-store`, `expo-crypto`; `expo-notifications` in step 3 | QR scanning, Android Keystore, secure random — all in Expo Go |
| Pairing QR | `qrcode-terminal` | QR shown in the desktop terminal |
| Models | freellmapi | OpenAI-compatible, your own keys |
| Leads | signalstack, unchanged | Add a notifier to its scheduler |
| Remote access (A) | Tailscale (free personal plan) | Handles NAT; nothing to host |
| Testing | Vitest | Core tests run on fake ports |
| Lint/format | Biome | One tool |
| CI | GitHub Actions, Ubuntu **and Windows** × Node 22 and 24 | Type-check, lint, test (APK build later); free for public repos |

**Total cost: $0.**

### Left out of v1

- **Desktop tray app** — "stop everything" is `malves stop` in the terminal.
- **App state library** — React's own state is enough.
- **Navigation library (Expo Router)** — three screens switch on one piece of state.
- **Runner web framework** — two local routes don't need one.

### Check before committing

- `expo-unified-push` maintenance — check the latest release. Fallback: the
  embedded FCM distributor or a small native module.
- UnifiedPush needs native code, so use an Expo **development build**, not Expo
  Go. Local APK builds are free.
- ~~`tweetnacl` needs a secure random source on React Native.~~ Done: `index.ts`
  calls `setRandomSource` with `expo-crypto` before anything else.
