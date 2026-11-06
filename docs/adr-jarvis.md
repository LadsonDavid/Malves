# Architectural Decision Records: Malves Companion (Jarvis Plan)

This document formalizes the architectural decisions made and implemented during the delivery of `docs/jarvis-plan.md`.

---

## ADR 01: Orchestrator Over Choreography for Multi-Agent Jobs
- **Status:** Accepted & Implemented (Pillar A)
- **Context:** Multiple agents cooperating on a complex task need coordination. Choreography (agents reacting directly to each other's messages) creates unpredictable cascading state, makes rollback ambiguous, and complicates progress reporting.
- **Decision:** Use an explicit **Orchestrator** (`Jobs` in `packages/core/src/jobs/jobs.ts`). The orchestrator owns the validated DAG plan, schedules steps when dependencies complete, enforces concurrency limits (default 3), directs outputs to the next agent, and orchestrates verify and pull request creation.
- **Consequences:** Single coordinator with fully deterministic, event-sourced recovery after restarts (`JobCreated`, `JobPlanned`, `JobApproved`, `JobStepUpdated`, `JobVerified`, `JobFinished`).

---

## ADR 02: A Git Worktree Per Step
- **Status:** Accepted & Implemented (Pillar A)
- **Context:** Having concurrent agents edit the same working copy causes git index contention, clobbered files, and impossible undo.
- **Decision:** Provide each job step with an isolated git worktree (`WorkspaceProvisioner` via `GitWorktrees` in `packages/runner/src/adapters/git/worktrees.ts`). Steps branch from the job's base commit into `<repo>-malves/<job>-<step>`.
- **Consequences:** Each step's changes are isolated, cleanly reviewable via git diff, and undo is simply deleting the branch. Integration worktrees resolve merges sequentially.

---

## ADR 03: Policy Tiers with Monotonic Safety Advisor
- **Status:** Accepted & Implemented (Foundations F1)
- **Context:** Binary "ask everything" produces prompt fatigue, while full autonomy creates catastrophic risk.
- **Decision:** Introduce three tiers:
  - **Tier 1 (Silent):** Read-only commands, status checks, safe inspection.
  - **Tier 2 (Journaled):** Modifying workspace files, running tests/builds, within-domain navigation.
  - **Tier 3 (User Approval):** Secret files, network pushes, deletions, financial/credential operations, sending emails.
  An advisor model (`Advisor`) can classify unknown actions, but is strictly **monotonic**: it can only maintain or lower permissions (downgrade to Tier 3), never bypass a hard deny rule.

---

## ADR 04: Content-Hashed Monitors Before Model Invocations
- **Status:** Accepted & Implemented (Foundations F2)
- **Context:** Polling monitors that call LLMs on every tick rapidly exhaust API rate limits and token budgets without providing value.
- **Decision:** Every monitor (command, URL, port) hashes its exact output payload before considering an LLM call. If the hash is unchanged from the prior check, the runner remains silent and avoids model invocation. Suggestions use a pending cap (max 5) and a permanent dismissal latch.

---

## ADR 05: Encrypted Browser Vault and Strict Origin Binding
- **Status:** Accepted & Implemented (Pillar B)
- **Context:** Agents frequently need credentials to access SaaS dashboards or portals, but exposing secrets to the LLM context risks leaks and prompt injections.
- **Decision:** Secrets are stored encrypted in `BrowserVault` using AES-256-GCM. The model only receives opaque handles. When filling credentials:
  1. The user explicitly confirms the fill on their paired device (Tier 3).
  2. The secret is sent over the local bridge directly to the browser extension.
  3. The extension validates that the target page's origin strictly equals the stored origin both in the background script and inside the page content script before filling.
  4. Secret strings are registered with `registerRedaction()` to guarantee redaction in logs and memory.

---

## ADR 06: Computer Operator Contract with Perceptual Frame IDs
- **Status:** Accepted & Implemented (Pillar C)
- **Context:** Pixel-based OS automation fails when the screen shifts between when the model observes a screenshot and when the click action executes.
- **Decision:** The `Computer` contract couples every `act(action, frameId)` to a specific perceptual frame identifier. If the perceptual hash of the screen changes by more than the threshold (~15%), the act is refused and a fresh snapshot is taken. Additionally, user mouse/keyboard activity initiates a 2-second take-over pause, and off-limits windows (passwords, banks, system UAC) are refused.

---

## ADR 07: Windows UI Automation and Vision Route
- **Status:** Accepted & Implemented (Pillar C)
- **Context:** Directly clicking coordinates is sensitive to DPI scaling and window positioning.
- **Decision:** Support UI Automation element trees (`UiElement`) as the primary selector contract (`elementId`) with coordinate/vision-based clicking as an automatic fallback when UI automation trees are unavailable.

---

## ADR 08: In-Process Embedded TypeScript Lead Engine
- **Status:** Accepted & Implemented (Pillar D)
- **Context:** Running a separate Python microservice for signalstack introduced multi-runtime friction, process orchestration complexity, and divergent scheduling.
- **Decision:** Port the lead database, collectors, and scoring to an embedded in-process TypeScript engine (`LocalLeadEngine` in `packages/runner/src/adapters/leads/`).
- **Consequences:** SQLite stores accounts and append-only signals. Scoring uses read-time computation where ICP fit strictly gates intent, and intent decays exponentially with a 14-day half-life. Collectors run politely with rate-limiting and declared User-Agents.

---

## ADR 09: Specialized Model Roles and Usage Budgeting
- **Status:** Accepted & Implemented (Foundations F3)
- **Context:** A single LLM model tier either underperforms on complex tasks or wastes budget on routine queries.
- **Decision:** Separate models into distinct roles:
  - `routine`: Fast, economical model for tool calls and heartbeats.
  - `planner`: Capable model for multi-step job planning and dependency DAG creation.
  - `reviewer`: Strict model for policy advice, verifier diff checking, and learning loop extraction.
  - `vision`: Specialized multimodal model for screen perception and UI element detection.
  All roles record model metadata and cost against the `BudgetGuard`.
