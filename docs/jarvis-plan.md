# Malves as a complete companion for developers: implementation plan

Status: **plan, nothing built yet.** Written after reading Hermes Agent and OpenClaw
(`external/`, both MIT) and the Malves code. Their **ideas** are used; no code is copied
without a `THIRD-PARTY.md` entry and the dissertation declaration first.

Out of scope, on purpose: messaging-app channels (Telegram, WhatsApp and the like: not
end-to-end encrypted), running the OpenClaw gateway beside Malves (it would duplicate the
runner), and LangGraph, OPA, Temporal and LiveKit (each adds infrastructure to an install that
must stay quick; what they give is a few hundred lines of TypeScript here).

---

## 1. What "done" looks like

You work. Malves is there without being called:

1. **Watches for you.** CI, pull requests, builds, servers, leads, a web page. It speaks only
   when something matters, and rings when it matters a lot.
2. **Acts within limits.** Reading, tests, lint and status just happen. Push, migrations,
   deleting and spending always stop and ask.
3. **Does whole jobs with several agents.** "Move the handshake to protocol v2 and update the
   tests" becomes a plan you approve once, three agents working in separate branches, a
   verification step, and one pull request you approve once.
4. **Operates the browser.** Multi-step portal work in your real, signed-in Chrome, including
   logins, without the model ever holding a password.
5. **Operates the computer like a person would.** It sees the screen, reads real buttons and
   fields, acts, checks that the action worked, and steps aside when you touch the machine.
6. **Runs your leads.** From a ranked list to a researched, drafted, approved and sent
   message, with the follow-up scheduled. No separate Python service.
7. **Knows you and the project**, and is present: hands-free voice, interruptions that really
   interrupt.

## 2. Rules that do not change

- **The brain proposes, code decides.** The policy engine is deterministic code. A model may
  *advise* about an unknown action; it can never turn an "ask" into a "yes" above tier 2.
- **Silence never means yes** for anything in tier 3 (R3).
- **The event log is the truth.** New features add events; no feature keeps hidden state that
  the log cannot rebuild.
- **`core` imports no adapter.** New ideas enter `core` as ports; `core/test/boundary.test.ts`
  keeps guarding it.
- **Windows first.** No `npx` or `.cmd` shims, paths through `node:path`, nothing that works
  around Windows Defender.
- **Every autonomous act is inspectable**: logged, shown in the journal, listed by
  `malves audit`, and switchable down.

## 3. Architecture: what is added where

```
phone app ── sealed link ──▶ runner (one process)
                              ├─ core (rules, no adapters)
                              │    policy ▸ decides allow / deny / ask for every action
                              │    automations ▸ triggers, schedules, monitors
                              │    jobs ▸ plan, steps, concurrency, verify, pull request
                              │    leads ▸ accounts, signals, scoring (read-time)
                              ├─ adapters
                              │    git worktrees · gh · monitor sources · browser vault
                              │    computer providers (UI Automation, vision) · collectors
                              └─ separate processes: ACP agents, video worker, ffmpeg
```

New ports in `core/src/ports.ts`: `Policy`, `WorkspaceProvisioner`, `Computer`, `Planner`,
`Clock` (exists; used by automations), `SecretStore`, `LeadSource`.

New event types (all in `protocol/src/events.ts`): `policy.decided`, `automation.created`,
`automation.fired`, `suggestion.offered|accepted|dismissed`, `job.created|planned|approved|
step.updated|verified|finished`, `computer.acted`, `lead.signal`, `lead.state`.

## 4. Foundations (needed by everything else)

### F1. Policy engine: risk tiers and limits

**Where it plugs in.** Every permission request from an ACP agent already arrives at
`Tasks.decide` through `permissionDecision(params)` in `runner/src/adapters/acp/host.ts`, and the
assistant's tool calls go through `Assistant.ask`. Both get a `Policy.evaluate(action)` call
first.

**Action shape.** Today a `Decision` has only text and a coarse risk. Add a structured
`action` next to it:

```ts
type Action = {
  source: "agent" | "assistant" | "automation" | "computer" | "browser";
  kind: "read" | "search" | "edit" | "delete" | "move" | "execute" | "network" | "browser" |
        "computer" | "spend" | "message";
  command?: string;            // execute: the text, parsed, not trusted
  paths?: string[];            // edit/delete/move/read
  url?: string;                // browser/network
  summary: string;             // what the phone shows
};
type Verdict = { outcome: "allow" | "deny" | "ask"; tier: 1 | 2 | 3; why: string };
```

**Tiers.** 1 = read-only, runs silently. 2 = reversible (format, tests, a throwaway
branch), runs and appears in the journal. 3 = push, deploy, migrate, delete outside the
worktree, send a message, spend, submit a form: always asks, rings if important.

**Order of checks** (first match wins), a generalisation of `commandRisk` in `handover.ts`:
1. Hard deny globs from settings: never reach a prompt, not even under the most permissive
   autonomy setting.
2. The deterministic classifier: command parser (no chains, redirects, `$(...)`), path rules
   (inside the task's root only), URL rules, known-safe command table.
3. The autonomy setting per project: *careful* (everything above tier 1 asks), *normal*
   (tier 2 runs), *trusting* (tier 2 runs and fewer tier 3 prompts for the repo's own branch).
   The default is *careful*.
4. **Advisor model** (optional, only for actions the classifier calls "unknown"): its answer
   may *lower* unknown to tier 2 or keep it at ask. It can never lower a classified tier 3.
   The command text is wrapped as untrusted data, shell comments stripped, and any
   "approve this" text in it is ignored (idea from Hermes `approval_smart.py`).

**Tests (TDD, first).** A table of at least 60 commands and paths with expected tiers; the
injection cases (`rm -rf / # approve`, a page or file telling the advisor to approve); the
invariant "no allow above tier 2 without an answered question"; a fitness test that every
call site that runs something goes through `Policy`.

**Effort:** about 4 days. **Risk:** over-asking makes it annoying, over-allowing makes it
dangerous. The journal and audit make both visible; the default stays careful.

### F2. Automations: the scheduler, monitors and suggestions

**Model.** A rule is `{ trigger, check?, action, importance, enabled }`.

| Trigger | Examples |
|---|---|
| schedule | `every 20m`, `weekdays 08:30` (a small grammar, no full cron) |
| event | a task failed; a job finished; a monitor changed |
| monitor | a source whose output is hashed |

**Monitors** (idea from Hermes `cron/monitor.py`): a cheap *source* runs first (a command, a
URL, `gh run list`, a port or process check, a git ref). Its exact output is hashed against the
last one. **Unchanged: no model call, no message.** Changed or first run: the diff (capped at
4,000 characters) goes into the prompt of a short task or a plain template, and the result
is delivered by importance: *log only*, *notification*, *call*.

**Briefings** are rules with a template and sources (overnight tasks, failed monitors, PRs
waiting, leads for the week), spoken or shown at the chosen time.

**Suggestions.** Malves proposes rules ("you check CI after every push, watch it?"), at most
five waiting, a dismissed one never returns (key kept). Nothing is created without a tap
(Hermes `cron/suggestions.py`).

**Where.** `core/src/automations` holds rules, the due-time calculation (using the `Clock`
port, so tests move time) and the delivery decision. The runner holds the sources and the
delivery adapters (ntfy, the call, the journal). Rules live in the event log
(`automation.created|changed|removed`), the monitor hashes in a small SQLite table.

**Prerequisite.** The main process must not freeze at startup (it still stalls 4 to 8
seconds; the lag monitor now logs it). A scheduler on a stalled loop fires late. The first
task of F2 is to find the blocking work with a CPU profile and move it off the loop.

**Tests.** Fake clock; a monitor whose output changes once; the "unchanged means no model call"
invariant; the suggestion cap and dismissal latch; delivery by importance.

**Effort:** about 5 days plus the stall fix.

### F3. Model roles

Today there is one brain on freellmapi. Introduce roles: `routine`, `planner`, `reviewer`
(advisor and verifier), `vision`, each with its own model setting and a default. The budget
guard already records which model answered; add the role and the cost to `task.usage`.
The planner, the advisor and computer use are the first things that need a stronger model:
their settings are separate so you can spend only there. No role ever silently falls to a
model below the quality floor (existing rule).

**Effort:** about 2 days.

## 5. Pillar A: several agents on one job

**Trade-off (orchestrated or choreographed).** Choreography (agents reacting to each other)
needs every agent to know the others and fails in ways that are hard to see. An
**orchestrator** (a job runner that owns the plan, starts steps, reads results and decides
what next) matches how Malves already works: tasks are events and the runner is the one
coordinator. It costs a single point of control; the event log makes that recoverable after
a restart. **Decision: orchestrator.**

**Trade-off (shared folder or worktrees).** Agents writing in one working copy overwrite and
confuse each other, and "undo" is guesswork. A **git worktree per step** gives each agent
its own branch and folder, makes undo "delete the branch", and makes the diff of one step
reviewable. It costs disk and a merge step. **Decision: worktree per step** (idea from
OpenClaw `managed-worktrees.md`).

### Data model (events, rebuilt by replay)

```
Job  { id, goal, workspaceId, state: planning|awaiting_plan|running|verifying|
       awaiting_pr|done|failed|stopped, plan: Step[] }
Step { id, role: implementer|tester|reviewer|verifier, agent, prompt,
       dependsOn: string[], branch, worktree, taskId?, state, summary? }
```

### Pieces

1. **Provisioner port** `WorkspaceProvisioner { create(job, step): {root, branch}; remove(...);
   merge(...) }`. Runner adapter: `git worktree add` into a sibling folder
   (`<repo>-malves/<job>-<step>`), branch `malves/<job>/<step>` from the job's base commit.
   `Tasks.create` gets an optional `root` so the agent starts in the worktree. Confinement
   already works from the root it is given.
2. **Planner** (role `planner`): asks the model for a plan as JSON, validated with zod
   (max 6 steps, known roles and agents, no cycles). **Plan → validate → execute**: the plan
   is shown on the phone as one question; nothing runs before a yes (idea: Huyen,
   *plan, validate, execute*).
3. **Role contracts.** Each role is a short written contract: scope (which folders), what it
   hands over (a summary and the branch), what needs approval, when to stop. Kept in
   `runner/src/agents/roles.ts` and added to the step prompt (idea from OpenClaw
   *parallel specialist lanes*).
4. **Job runner** in `core/src/jobs`: starts every step whose dependencies are done, up to a
   cap (default 3 at once, one per agent session), reads the result events, and handles
   failure (retry once, then stop the job and keep the worktrees for inspection).
5. **Verify step.** In the job's integration worktree: run the project's test and lint
   commands (found from `package.json` or the project notes; tier 2), then a second agent
   reads the diff. A failure returns to the implementer **at most twice** (reflection, with
   a limit), then asks you.
6. **Integration and pull request.** Merge the step branches into an integration branch in
   order; a conflict becomes an "integrator" step. `gh pr create` runs through policy (tier
   3: asks once, shows the diff and the summary). Worktrees are removed after the PR is
   open or the job is stopped.
7. **Steering.** A message sent to a running job reaches the right agent at its next
   tool boundary (ACP `session/cancel` then a prompt carrying the new instruction in the same
   session), never in the middle of a running tool. Agents that cannot resume say so.
8. **Phone.** A Job screen: the plan, each step's agent and live activity, the verify result,
   one approval for the plan and one for the PR.

**Tests.** The job runner with the existing scripted host fakes (plan JSON in, step order
out, cap respected, failure and retry); the provisioner against temporary git repositories
(create, edit, merge, conflict, remove); a recovery test (restart mid-job: steps that were
running are marked failed, worktrees kept); the planner with a fake model returning bad JSON,
cycles and unknown agents.

**Demo (acceptance).** "Move the handshake to protocol v2 and update the tests": a plan of
three steps on the phone, one yes, three branches working at once, a green verify, a pull
request asked once.

**Effort:** about 10 days.

## 6. Pillar B: browser operator

**What exists.** A Chrome extension in your real browser, an MCP tool server per task, an
approval for each new site and each click, and password and card fields refused. Safe, but it
cannot log in, trips on dialogs and iframes, and cannot hold a long job.

**Decisions kept.** Real Chrome, current profile, no separate Playwright browser (CLAUDE.md).

**Additions**

1. **Policy tiers instead of asking for everything.** Reading a site you already approved:
   tier 1. Clicking inside it: tier 2 (logged). Submitting a form, sending, buying,
   deleting: tier 3. Page text is always data, never instructions.
2. **Secret autofill the model never sees** (idea from Hermes `browser_vault_tool.py`).
   The runner holds an encrypted vault (NaCl, key kept as the other secrets are). The model
   sees only a *handle* and the site. To fill, the runner asks your phone once ("fill the
   Stripe login?"), then sends the secret straight to the extension over the loopback
   bridge, which fills the field **only if the page origin equals the one saved**, checked
   again inside the page. The result reports only "filled". The secret's bytes are
   registered for redaction in logs, results and memory. A one-time code (TOTP) is the same
   path. **This reverses the current rule "password and card fields are always refused".
   It is a decision for you (D1 below).**
3. **Dialogs and frames.** The extension's debugger permission lets it see JavaScript
   dialogs and cross-origin frames and answer them by policy (accept alerts, ask for
   `beforeunload`).
4. **Long jobs.** A browsing session survives a step: tab group "Malves", a stored
   "where I was" (URL, scroll, the last snapshot hash), wait-for-condition calls (element
   present, text present, URL changed), and retries with a back-off.
5. **Structured extraction.** The tool takes a zod schema and returns validated data
   (a table of invoices, a list of prices), so downstream steps and leads can rely on it.
6. **Does not steal your window.** Runs in a background tab group; the phone can show it.

**Tests.** The bridge and tools against a fake extension; the vault (add, fill on the right
origin, refuse on a different origin, redaction); policy cases for the tiers; the extension's
page tests extended for dialogs. Real-Chrome acceptance script on a local test site.

**Demo.** "Download last month's invoices from the supplier portal and put the totals in a
table": it logs in with one phone approval, reads three pages, returns the table.

**Effort:** about 8 days.

## 7. Pillar C: the computer operator

**What exists.** Handover mode: nut.js mouse, keyboard and screen; a read-back for each
click; windows with "password", "sign in", "bank" and similar in the title are off limits;
live video at 60 frames a second with ffmpeg. It works by looking at pixels, slowly.

**Ideas from OpenClaw `computer-use.md`:** one `act` contract with a **frame id**, a provider
behind it (so the way of acting can change), and a **take-over handshake**.

**The contract**

```ts
interface Computer {
  snapshot(): Promise<{ frameId: string; jpeg: string; width: number; height: number;
                        elements?: UiElement[] }>;       // elements when a UI tree is available
  act(a: Act, frameId: string): Promise<ActResult>;      // click|double|right|type|keys|scroll|drag|wait
}
type UiElement = { id: string; role: string; name: string; rect: Rect; enabled: boolean;
                   app: string; window: string };
```

**Behaviour**

1. **Frame rule.** An act names the frame it was decided on. If the screen has changed more
   than a threshold since (a perceptual hash of the region), the act is refused and the agent
   gets a fresh snapshot. This stops clicking where a button *used to be*.
2. **Check after acting.** After each act: a new snapshot, a diff of the target region, and
   an "expected change" check by the model; no change twice means stop and report.
3. **Reading real controls.** A provider that returns the **Windows UI Automation tree**
   (buttons, fields, menus with names and positions), so the agent says "click the *Save*
   button" and the provider clicks the element, not a guessed pixel. Pixel clicking with a
   vision model stays as the fallback for apps with no tree.
4. **Take-over.** While you type or move the mouse, the agent's input **pauses** (it may keep
   watching); it resumes after two idle seconds. Handover does not end (existing decision).
   This needs your yes (D2 below).
5. **Policy per act.** Looking and moving: tier 1. Clicks and typing in an allowed app
   (a setting per app): tier 2. Send, delete, install, pay, confirm: tier 3, detected from
   the element name or window text and a vision check. The per-click read-back is replaced
   by this (it stays for tier 3).
6. **Off-limits stays** (passwords, sign-ins, banking, admin prompts): never automated.
7. **Phone.** The live view shows the agent's pointer and the next action as an overlay, and
   a "take over" button.

**Spike first (3 days), because the route is uncertain.** Three ways to get the UI
Automation tree on Windows from Node:
- a small helper built from our own source (C# or Rust) that wraps UI Automation. Cleanest
  result; **risk:** helper executables have been flagged by Windows Defender before, and we
  never work around that. It would ship signed and from a repository, or not at all.
- calling the UI Automation COM interface directly from Node through an FFI library: no new
  executable, harder to build and debug.
- OpenClaw's `cua-computer` plugin and its pinned driver: ready-made, but a large dependency
  to vet (licence, size, how it is updated).

The spike builds the smallest "list the buttons of Notepad and click Save" with each route,
measures speed and reliability, and checks that Defender stays quiet. The result is an ADR.

**Tests.** A fake `Computer` for the frame rule, the take-over pause, the policy classes and
the after-check loop; unit tests for the perceptual hash threshold; a manual acceptance
script on Notepad and Calculator (real machine).

**Demo.** "Open Notepad, type this summary, save it as report.txt in Documents": done, with
the save approved as tier 3 only if you set it so; you move the mouse in the middle and it
waits, then continues.

**Effort:** about 12 days plus the 3-day spike.

## 8. Pillar D: leads, inside Malves

**Today.** signalstack (Python, about 4,900 lines: collectors, scoring, a web page, a
scheduler) runs separately and the runner reads `GET /api/leads`. You asked for no separate
service.

**Trade-off (port or keep).** Keeping Python means two runtimes and a manual setup; porting
to TypeScript costs effort but gives one install, the same scheduler and policy, and a clear
piece of original work for the dissertation. signalstack stays as its own open-source
project; Malves gets its own implementation of the same design. **Decision: port in
stages, with golden-output parity tests against the Python version.**

### Stages

- **D1: data and scoring.** SQLite tables: accounts, an **append-only signal log**, and
  scores computed **at read time** from the log (fit gates intent, intent decays), exactly
  the design in signalstack's README. Your ideal-customer description is entered on the
  phone ("who do you sell to?"), not in a YAML file. Parity tests feed the same fixtures to
  both implementations and compare ranked lists.
- **D2: collectors that need no login.** Hiring boards (Greenhouse, Lever, Ashby), "Hacker
  News who is hiring", status pages, tech-stack fingerprinting by HTTP, community posts
  (Hacker News, Lobsters, Dev.to), GitHub with a token. Each is a small collector with a
  recorded-HTTP fixture test. They run from the F2 scheduler, politely (robots rules,
  rate limits, a declared user agent); each collector's terms are checked before it ships.
- **D3: dossier.** For a chosen lead the browser operator (pillar B) reads the company site
  and recent news and the planner writes a short dossier with sources.
- **D4: outreach loop.** Draft the message (planner), show it on the phone, **you approve
  or edit**, it is sent (Gmail through the browser operator, or a `mailto` fallback), the
  lead moves to *contacted*, and a follow-up rule is created with your yes.
- **D5: light CRM.** Lead state (new, contacted, replied, won, lost) as events; a monitor
  can watch for a reply; the weekly digest stays.

**Tests.** Collector fixtures; scoring parity; the policy rule that **sending is tier 3,
always**; a test that nothing is sent without an answered question.

**Demo.** "Work this week's hot leads": the top five get a dossier and a drafted opener on
the phone; you approve two; they go out; follow-ups are scheduled.

**Effort:** about 15 days (D1 3, D2 5, D3 2, D4 3, D5 2).

## 9. Knowing you and the project (J4), and being present (J5)

**Learning loop.** After each finished task a short reviewer (role `reviewer`) asks "is there
a skill or a memory worth saving?" and offers it as a suggestion (pending cap and dismissal
latch as in F2). Saved only on your tap. (Hermes `agent/background_review.py`.)

**Project notes.** The commands that worked, the conventions, the pitfalls, per project, in
the vault; used by the planner and the verify step.

**Search.** SQLite FTS5 over every past session and the vault ("what did we decide about the
auth retry?"), answers with their source. Deep recall by a model only when the question is
about the past and the fast search found nothing (OpenClaw `active-memory.md`).

**Consolidation.** A nightly note that merges the day's journal into the project notes,
keeping the previous text so a bad merge can be undone (OpenClaw `dreaming.md`).

**Presence.** Hands-free on the phone with an offline wake word (a small, permissively
licensed engine; a 2-day spike compares Vosk and an ONNX wake-word model), barge-in that
also **stops the running step**, optional spoken heads-ups on the PC speakers, presence
signals (active window, idle, build state) from the IDE bridge and the screen tools without
a model call.

**Effort:** learning, notes, search, consolidation about 6 days; presence about 8 days.

## 10. Order of work

| Phase | What | Days (rough) | Why here |
|---|---|---|---|
| 1 | F3 model roles, F1 policy, F2 automations (with the startup stall fix) | 11 | Everything else needs limits, a scheduler and the right models |
| 2 | Pillar A: jobs, worktrees, planner, verify, pull request | 10 | The most visible change, and the base for the others |
| 3 | Pillar B: browser tiers, vault, dialogs, long jobs, extraction | 8 | Needed by leads |
| 4 | Pillar D, stages D1 to D2 | 8 | Data first, independent of the browser work |
| 5 | Pillar C: spike, then the computer operator | 15 | Largest unknown, after the policy exists to contain it |
| 6 | Pillar D, stages D3 to D5 | 7 | Needs pillars B and the planner |
| 7 | Learning, search, consolidation, presence | 14 | Makes it feel like a colleague |

About 73 working days in total. These are rough and will move; each phase ends with its
demo, and a phase that runs long is cut down, not stretched.

## 11. Verification approach

- **Test first** for logic; fakes for the clock, the host, the computer, the extension and the
  model, as the codebase does today.
- **A table-driven check per safety rule**, in the style of the existing "a fooled brain
  changes nothing without a yes" table: policy tiers, the vault origin rule, the frame rule,
  "sending is always tier 3".
- **Fitness functions:** the `core` boundary test; a test that every place that runs
  something goes through `Policy`; a test that no secret reaches a log.
- **Planner and advisor evaluations:** scenario tables (including injection attempts) run with
  scripted models in CI and, optionally, with the real brain on demand.
- **A real-device acceptance script per phase**, written as numbered steps with the expected
  result, run by you on the phone.

## 12. Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | Allow the vault autofill, reversing "passwords are always refused" in the extension | Yes, with a phone approval for every fill and strict origin binding |
| D2 | Pause the agent's input while you touch the machine (handover itself never ends) | Yes |
| D3 | A stronger model for planner, advisor and computer use, with its cost shown and capped | Yes, for those roles only; everything else stays on free models |
| D4 | Port the lead engine to TypeScript (signalstack stays its own project) | Yes |
| D5 | Hermes as an optional extra agent (needs Python and uv) | Later, after a trial; not on the critical path |

## 13. Risks

- **Autonomy that surprises you.** Mitigation: tiers are visible, the default is careful, tier
  2 appears in the journal, `malves audit` lists everything, one switch turns it all down.
- **The free models are weak at planning and tool use.** Mitigation: model roles (F3); the
  planner, advisor and computer use are first in line for a stronger model.
- **UI Automation on Windows may be hard to ship without upsetting Defender.** Mitigation:
  the spike before any commitment; the pixel and vision route remains.
- **Browser automation is brittle.** Mitigation: wait-for conditions, retries, structured
  extraction, and a clear "I'm stuck, here is where" report.
- **Scraping terms.** Mitigation: each collector's terms checked before it ships; polite
  rates; no collector that needs a login.
- **Scope.** About 73 days is a lot. Phases are independently useful and end with a demo.

## 14. ADRs to add when built

Orchestrator over choreography for jobs; a worktree per step; policy tiers with an advisor
that can only lower unknown actions; monitors that hash before they think; the vault and
origin binding; the computer contract with a frame id; the UI Automation route (after the
spike); porting the lead engine; model roles.

## 15. Ideas taken, and from where

| Idea | Source |
|---|---|
| Monitors hashed before any model call; suggestions with a cap and a dismissal latch | Hermes `cron/monitor.py`, `cron/suggestions.py` |
| Deny rules before any bypass; advisor model treating the command as untrusted | Hermes `tools/approval_floors.py`, `approval_smart.py` |
| Background reviewer proposing skills and memories | Hermes `agent/background_review.py` |
| Origin-bound secret autofill the model never sees | Hermes `tools/browser_vault_tool.py` |
| A worktree per task; steering at tool boundaries; lane contracts | OpenClaw `managed-worktrees.md`, `queue-steering.md`, `parallel-specialist-lanes.md` |
| One `act` contract with a frame id; take-over handshake | OpenClaw `nodes/computer-use.md` |
| Memory consolidation with reviewable output; escalating recall | OpenClaw `dreaming.md`, `active-memory.md` |
