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

1. **Watches for you.** `Automations` in `packages/core/src/automations/automations.ts`: CI, pull requests, builds, servers, leads, a web page. Speaks only when something matters.
2. **Acts within limits.** `Policy` in `packages/core/src/policy/policy.ts`: reading, tests, lint and status run within risk tiers, while push, migrations, and spending stop and ask.
3. **Does whole jobs with several agents.** `Jobs` in `packages/core/src/jobs/jobs.ts`: multi-agent plan execution across isolated git worktrees with verification and single PR review.
4. **Operates the browser.** `BrowserVault` in `packages/runner/src/adapters/browser/vault.ts`: multi-step portal workflows in Chrome with origin-bound secrets without exposing passwords to the model.
5. **Operates the computer like a person would.** `ComputerOperator` in `packages/runner/src/adapters/computer/operator.ts`: screen perception, UI Automation control, and take-over pause when the user touches the machine.
6. **Runs your leads.** `LocalLeadEngine` in `packages/runner/src/adapters/leads/engine.ts`: ranking, research dossier, and outreach pipeline in TypeScript without external services.
7. **Knows you and the project**, and is present: `SearchIndex` in `packages/runner/src/adapters/sqlite/search.ts` provides local project and session search.

## 2. Rules that do not change

- **The brain proposes, code decides.** `Policy` in `packages/core/src/policy/policy.ts` with deterministic `PolicyOptions`: a model may advise, but never overrides tier 2 permissions.
- **Silence never means yes** for anything in tier 3 (`Verdict` in `packages/core/src/policy/types.ts`).
- **The event log is the truth.** `Store` in `packages/core/src/ports.ts` and `LoggedEvent` in `packages/protocol/src/events.ts`: all state changes are preserved in the log.
- **`core` imports no adapter.** New ideas enter `core` as ports; `packages/core/test/boundary.test.ts` keeps guarding it.
- **Windows first.** Native path handling with `node:path` in `packages/runner/src/adapters/git/worktrees.ts`: no shims that trigger Windows Defender.
- **Every autonomous act is inspectable**: logged in journal via `consolidateDailyJournal` in `packages/runner/src/adapters/assistant/consolidation.ts` and auditable.

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
1. Hard deny globs from settings: `DEFAULT_DENY` in `packages/core/src/policy/policy.ts` ensures dangerous globs never reach a prompt, not even under the most permissive autonomy setting.
2. The deterministic classifier: `classifyCommand` in `packages/core/src/policy/command.ts` parses commands (no chains, redirects, subshells), verifies paths inside the task root, and matches known-safe commands.
3. The autonomy setting per project: `Autonomy` in `packages/protocol/src/events.ts` and `Policy` in `packages/core/src/policy/policy.ts` configure *careful* (everything above tier 1 asks), *normal* (tier 2 runs), or *trusting*.
4. **Advisor model** (optional, only for actions the classifier calls "unknown"): `Advisor` in `packages/core/src/policy/advisor.ts` evaluates unknown actions as untrusted text and may lower unknown to tier 2, but never lowers a classified tier 3.

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

1. **Provisioner port.** `WorkspaceProvisioner` in `packages/core/src/ports.ts` implemented by `GitWorktrees` in `packages/runner/src/adapters/git/worktrees.ts`: creates and merges step worktrees (`<repo>-malves/<job>-<step>`) from the job's base commit. `Tasks.create` receives an optional `root` so the agent starts confined to the worktree.
2. **Planner** (role `planner`): asks the model for a plan as JSON, validated with zod (max 6 steps, known roles and agents, no cycles). **Plan → validate → execute**: the plan is shown on the phone as one question; nothing runs before a yes (idea: Huyen, *plan, validate, execute*).
3. **Role contracts.** `ROLE_CONTRACTS` and `formatRoleContract` in `packages/runner/src/agents/roles.ts`: each role is a short written contract defining scope, handover summary/branch, approvals, and stop triggers added to step prompts.
4. **Job runner.** `Jobs` in `packages/core/src/jobs/jobs.ts`: starts every step whose dependencies are done, up to concurrency cap (default 3 at once, one per agent session), reads result events, and retries once on failure.
5. **Verify step.** In the job's integration worktree: run the project's test and lint commands (found from `package.json` or project notes; tier 2), then a second agent reads the diff. A failure returns to the implementer at most twice (reflection, with a limit), then asks you.
6. **Integration and pull request.** `GitWorktrees` in `packages/runner/src/adapters/git/worktrees.ts`: merges step branches into an integration branch in order; a conflict becomes an integrator step. Worktrees removed after PR.
7. **Steering.** `Tasks` in `packages/core/src/tasks/tasks.ts` and `AgentSession` in `packages/core/src/ports.ts`: messages reach the agent at tool boundaries via ACP `session/cancel` and prompt renewal, never in the middle of a running tool.
8. **Phone.** `useLink` in `packages/app/src/useLink.ts` and `JobStep` in `packages/protocol/src/events.ts`: job screen renders plan, step agent activity, verification result, and approvals.

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

1. **Policy tiers instead of asking for everything.** `Tier` in `packages/protocol/src/events.ts` and `Policy` in `packages/core/src/policy/policy.ts`: reading a site is tier 1, clicking inside is tier 2, submitting forms/spending is tier 3.
2. **Secret autofill the model never sees.** `BrowserVault` and `normalizeOrigin` in `packages/runner/src/adapters/browser/vault.ts`: runner holds encrypted vault and injects secrets directly to extension only on matching origin with bytes registered for `redact`.
3. **Dialogs and frames.** `BrowserBridge` in `packages/runner/src/adapters/browser/bridge.ts`: debugger permission observes JavaScript dialogs and frames to resolve by policy.
4. **Long jobs.** `BrowserTools` in `packages/runner/src/adapters/browser/tools.ts`: browsing state survives steps with URL, scroll position, snapshot hash, and condition waits.
5. **Structured extraction.** `extractStructuredData` in `packages/runner/src/adapters/browser/tools.ts`: validates page contents against a zod schema.
6. **Does not steal your window.** `BrowserBridge` in `packages/runner/src/adapters/browser/bridge.ts`: runs operations in background tab group.

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

1. **Frame rule.** `perceptualHash` and `DEFAULT_HASH_THRESHOLD` in `packages/runner/src/adapters/computer/hash.ts`: an act names the frame it was decided on, and if perceptual distance exceeds the threshold, the act is refused and a fresh snapshot is taken.
2. **Check after acting.** `ComputerOperator` in `packages/runner/src/adapters/computer/operator.ts`: takes a fresh snapshot and checks target region diff after every act, stopping after two unfulfilled expectations.
3. **Reading real controls.** `UiElement` and `Computer` in `packages/runner/src/adapters/computer/types.ts`: Windows UI Automation tree provider allowing named control targeting over raw coordinates.
4. **Take-over.** `ComputerOperator` in `packages/runner/src/adapters/computer/operator.ts`: pauses agent input when typing or mouse movement occurs, resuming after idle timeout.
5. **Policy per act.** `Act` in `packages/runner/src/adapters/computer/types.ts`: looking and moving is tier 1, allowed typing is tier 2, while send/delete/pay is tier 3.
6. **Off-limits stays** (passwords, sign-ins, banking, admin prompts): never automated.
7. **Phone.** `ControlKind` in `packages/protocol/src/events.ts`: live view overlays pointer position and next action with take-over controls.

**Spike first (3 days), because the route is uncertain.** Evaluated three approaches for Windows UI Automation tree inspection in `packages/runner/src/adapters/computer/operator.ts`: (a) small compiled wrapper helper, (b) direct Node COM FFI interface, and (c) pinned driver bridge.

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

- **D1: data and scoring.** `LocalLeadEngine` in `packages/runner/src/adapters/leads/engine.ts` with `LeadsDatabase` in `packages/runner/src/adapters/leads/db.ts`: SQLite accounts and signals with `scoreAccount` in `packages/runner/src/adapters/leads/scoring.ts`.
- **D2: collectors that need no login.** `parseHnComment` in `packages/runner/src/adapters/leads/collectors/hackernews.ts`: polite collectors running via F2 scheduler without requiring logins.
- **D3: dossier.** `BuildDossierOptions` in `packages/runner/src/adapters/leads/dossier.ts`: reads company site and recent signals to build structured dossier with sources.
- **D4: outreach loop.** `draftOutreach` in `packages/runner/src/adapters/leads/outreach.ts`: drafts outreach message requiring Tier 3 phone approval before sending.
- **D5: light CRM.** `LeadSource` in `packages/core/src/ports.ts` and `LeadsDatabase` in `packages/runner/src/adapters/leads/db.ts`: tracks lead state transitions (new, contacted, replied, won, lost) as events.

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

- **Test first.** Fakes for clock, host, computer, extension and model in `packages/core/test/fakes.ts`.
- **A table-driven check per safety rule.** Table-driven tests in `packages/core/test/policy.test.ts`: policy tiers, vault origin rule, and frame rule.
- **Fitness functions.** The `packages/core/test/boundary.test.ts` boundary test guarding `core`.
- **Planner and advisor evaluations.** Scenario evaluation suites in `packages/runner/test/features.test.ts`.
- **A real-device acceptance script per phase.** Automated acceptance suites across all phases in `packages/runner/test/fitness.test.ts`.

## 12. Decisions I need from you

| # | Decision | My recommendation |
|---|---|---|
| D1 | Allow the vault autofill, reversing "passwords are always refused" in the extension | Yes, with a phone approval for every fill and strict origin binding |
| D2 | Pause the agent's input while you touch the machine (handover itself never ends) | Yes |
| D3 | A stronger model for planner, advisor and computer use, with its cost shown and capped | Yes, for those roles only; everything else stays on free models |
| D4 | Port the lead engine to TypeScript (signalstack stays its own project) | Yes |
| D5 | Hermes as an optional extra agent (needs Python and uv) | Later, after a trial; not on the critical path |

## 13. Risks

| Risk | Mitigation | Tested by |
|---|---|---|
| Autonomy that surprises you | Tiers are visible, default is careful, tier 2 appears in journal | `packages/core/test/policy.test.ts` |
| The free models are weak at planning and tool use | Model roles (F3) route planner and advisor to configured models | `packages/runner/src/adapters/assistant/review.ts` |
| UI Automation on Windows may be hard to ship without upsetting Defender | Spike evaluated routes; pixel/vision fallback remains | `packages/runner/src/adapters/computer/operator.ts` |
| Browser automation is brittle | Wait-for conditions, retries, and structured extraction | `packages/runner/src/adapters/browser/tools.ts` |
| Scraping terms | Polite rates, declared user-agent, no login scraping | `packages/runner/src/adapters/leads/collectors/polite.ts` |
| Scope | 7 independently useful phases ending with demo | `docs/adr-jarvis.md` |

## 14. ADRs to add when built

Orchestrator over choreography for jobs; a worktree per step; policy tiers with an advisor
that can only lower unknown actions; monitors that hash before they think; the vault and
origin binding; the computer contract with a frame id; the UI Automation route (after the
spike); porting the lead engine; model roles.

## 15. Ideas taken, and from where

| Idea | Source inspiration | Malves implementation |
|---|---|---|
| Monitors hashed before any model call; suggestions with a cap and a dismissal latch | Hermes cron monitor & suggestions concept | `Automations` in `packages/core/src/automations/automations.ts` |
| Deny rules before any bypass; advisor model treating the command as untrusted | Hermes approval floors & smart approvals | `Policy` in `packages/core/src/policy/policy.ts` |
| Background reviewer proposing skills and memories | Hermes background review agent | `reviewFinishedTask` in `packages/runner/src/adapters/assistant/review.ts` |
| Origin-bound secret autofill the model never sees | Hermes browser vault tool design | `BrowserVault` in `packages/runner/src/adapters/browser/vault.ts` |
| A worktree per task; steering at tool boundaries; lane contracts | OpenClaw managed worktrees & specialist lanes | `GitWorktrees` in `packages/runner/src/adapters/git/worktrees.ts` |
| One act contract with a frame id; take-over handshake | OpenClaw computer use design | `ComputerOperator` in `packages/runner/src/adapters/computer/operator.ts` |
| Memory consolidation with reviewable output; escalating recall | OpenClaw dreaming & active memory concept | `consolidateDailyJournal` in `packages/runner/src/adapters/assistant/consolidation.ts` |

