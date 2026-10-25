import { z } from "zod";

/**
 * The event vocabulary. Every change in the runner is one of these, appended to
 * the log with a sequence number. The phone receives the same shapes, so field
 * names use the wire convention (snake_case).
 */

export const TaskState = z.enum(["queued", "running", "waiting", "done", "failed", "stopped"]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_STATES: readonly TaskState[] = ["done", "failed", "stopped"];

/** Every kind of human decision goes through the one questions module. */
export const QuestionKind = z.enum([
  "agent_question",
  "permission",
  "browser_action",
  "budget_floor",
  "commit_approval",
]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

export const Choice = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type Choice = z.infer<typeof Choice>;

export const QuestionOutcome = z.enum(["answered", "timed_out", "cancelled"]);
export type QuestionOutcome = z.infer<typeof QuestionOutcome>;

const WorkspaceRegistered = z.object({
  type: z.literal("workspace.registered"),
  data: z.object({
    workspace_id: z.string(),
    name: z.string(),
    path: z.string(),
  }),
});

const WorkspaceRemoved = z.object({
  type: z.literal("workspace.removed"),
  data: z.object({ workspace_id: z.string() }),
});

const TaskCreated = z.object({
  type: z.literal("task.created"),
  data: z.object({
    task_id: z.string(),
    workspace_id: z.string(),
    agent: z.string(),
    prompt: z.string(),
    /** Continues this earlier agent session instead of starting a new one. */
    resume_session: z.string().optional(),
  }),
});

/** The agent opened (or continued) this session for the task; a reply can continue it. */
const TaskSession = z.object({
  type: z.literal("task.session"),
  data: z.object({ task_id: z.string(), session_id: z.string() }),
});

const TaskUpdated = z.object({
  type: z.literal("task.updated"),
  data: z.object({
    task_id: z.string(),
    state: TaskState,
    reason: z.string().optional(),
  }),
});

const TaskResult = z.object({
  type: z.literal("task.result"),
  data: z.object({
    task_id: z.string(),
    text: z.string(),
  }),
});

/** The model now answering for this task (logged at the start and at every switch, R8). */
const TaskModel = z.object({
  type: z.literal("task.model"),
  data: z.object({ task_id: z.string(), model: z.string() }),
});

/** What a model was asked to do. Each role has its own model setting (plan F3). */
export const ModelRole = z.enum(["routine", "planner", "reviewer", "vision"]);
export type ModelRole = z.infer<typeof ModelRole>;

/** Tokens a metered task used, through the budget guard. Logged when it ends. */
const TaskUsage = z.object({
  type: z.literal("task.usage"),
  data: z.object({
    task_id: z.string(),
    calls: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    /** Which role the model answered for, when known. */
    role: ModelRole.optional(),
    /** Money spent, when the role has a price. Free models leave it out. */
    cost_usd: z.number().nonnegative().optional(),
  }),
});

// ── Policy (F1): risk tiers and limits ──────────────────────────────────────

/** 1 = read-only, silent. 2 = reversible, runs and is journaled. 3 = always asks. */
export const Tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof Tier>;

export const ActionSource = z.enum(["agent", "assistant", "automation", "computer", "browser"]);
export type ActionSource = z.infer<typeof ActionSource>;

export const ActionKind = z.enum([
  "read",
  "search",
  "edit",
  "delete",
  "move",
  "execute",
  "network",
  "browser",
  "computer",
  "spend",
  "message",
]);
export type ActionKind = z.infer<typeof ActionKind>;

/** careful: everything above tier 1 asks. normal: tier 2 runs. trusting: also remembers a yes. */
export const Autonomy = z.enum(["careful", "normal", "trusting"]);
export type Autonomy = z.infer<typeof Autonomy>;

/** Every decision above a silent read, and every refusal, is in the log: `malves audit` lists them. */
const PolicyDecided = z.object({
  type: z.literal("policy.decided"),
  data: z.object({
    task_id: z.string().optional(),
    source: ActionSource,
    kind: ActionKind,
    tier: Tier,
    outcome: z.enum(["allow", "deny", "ask"]),
    why: z.string().max(300),
    summary: z.string().max(300),
  }),
});

/** A project's autonomy setting. `*` caps every project at once: the one switch that turns it all down. */
const PolicyAutonomy = z.object({
  type: z.literal("policy.autonomy"),
  data: z.object({ workspace_id: z.string(), autonomy: Autonomy }),
});

// ── Automations (F2): schedules, monitors, suggestions ──────────────────────

export const Importance = z.enum(["log", "notification", "call"]);
export type Importance = z.infer<typeof Importance>;

/** What a monitor looks at. Its exact output is hashed; unchanged means nobody is told. */
export const MonitorSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string().min(1), workspace_id: z.string() }),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }),
  z.object({ kind: z.literal("port"), host: z.string().min(1), port: z.number().int().positive() }),
]);
export type MonitorSource = z.infer<typeof MonitorSource>;

export const AutomationTrigger = z.discriminatedUnion("kind", [
  /** `every 20m`, `weekdays 08:30` (a small grammar, not cron). */
  z.object({ kind: z.literal("schedule"), schedule: z.string().min(1) }),
  z.object({
    kind: z.literal("event"),
    on: z.enum(["task.failed", "task.done", "monitor.changed"]),
  }),
  z.object({ kind: z.literal("monitor"), every: z.string().min(1), source: MonitorSource }),
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationAction = z.discriminatedUnion("kind", [
  /** A plain template: `{{name}}`, `{{diff}}`, `{{output}}`, `{{task}}`, `{{reason}}`. */
  z.object({ kind: z.literal("notify"), template: z.string().min(1).max(2000) }),
  /** A short task whose prompt is the template; its result is what gets delivered. */
  z.object({
    kind: z.literal("task"),
    workspace_id: z.string(),
    agent: z.string(),
    prompt: z.string().min(1).max(4000),
  }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationRule = z.object({
  name: z.string().min(1).max(120),
  trigger: AutomationTrigger,
  action: AutomationAction,
  importance: Importance,
  enabled: z.boolean(),
});
export type AutomationRule = z.infer<typeof AutomationRule>;

const AutomationCreated = z.object({
  type: z.literal("automation.created"),
  data: z.object({ rule_id: z.string(), rule: AutomationRule }),
});

const AutomationChanged = z.object({
  type: z.literal("automation.changed"),
  data: z.object({ rule_id: z.string(), rule: AutomationRule }),
});

const AutomationRemoved = z.object({
  type: z.literal("automation.removed"),
  data: z.object({ rule_id: z.string() }),
});

/** A rule did something. Unchanged monitors never get here: no change, no event. */
const AutomationFired = z.object({
  type: z.literal("automation.fired"),
  data: z.object({
    rule_id: z.string(),
    reason: z.enum(["schedule", "event", "monitor"]),
    importance: Importance,
    text: z.string().max(4000),
    task_id: z.string().optional(),
  }),
});

/** Malves proposes a rule. Nothing is created without a tap (at most five wait at once). */
const SuggestionOffered = z.object({
  type: z.literal("suggestion.offered"),
  data: z.object({
    suggestion_id: z.string(),
    /** Stable key: a dismissed suggestion with this key never comes back. */
    key: z.string().min(1),
    text: z.string().min(1).max(400),
    rule: AutomationRule,
  }),
});

const SuggestionAccepted = z.object({
  type: z.literal("suggestion.accepted"),
  data: z.object({ suggestion_id: z.string(), rule_id: z.string() }),
});

const SuggestionDismissed = z.object({
  type: z.literal("suggestion.dismissed"),
  data: z.object({ suggestion_id: z.string(), key: z.string() }),
});

/** Files a finished task changed in a git project (only the task's own, not earlier edits). */
const TaskChanges = z.object({
  type: z.literal("task.changes"),
  data: z.object({
    task_id: z.string(),
    files: z.array(
      z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() }),
    ),
  }),
});

/** The user approved, and the task's changes were committed. */
const TaskCommitted = z.object({
  type: z.literal("task.committed"),
  data: z.object({ task_id: z.string(), commit: z.string() }),
});

const QuestionOpened = z.object({
  type: z.literal("question.opened"),
  data: z.object({
    question_id: z.string(),
    task_id: z.string(),
    kind: QuestionKind,
    text: z.string(),
    choices: z.array(Choice).min(1),
    risk: Risk,
    expires_at: z.number().int(),
  }),
});

const QuestionClosed = z.object({
  type: z.literal("question.closed"),
  data: z.object({
    question_id: z.string(),
    task_id: z.string(),
    outcome: QuestionOutcome,
    choice_id: z.string().optional(),
    command_id: z.string().optional(),
  }),
});

const DevicePaired = z.object({
  type: z.literal("device.paired"),
  data: z.object({
    device_id: z.string(),
    name: z.string(),
    public_key: z.string(),
  }),
});

const DeviceRevoked = z.object({
  type: z.literal("device.revoked"),
  data: z.object({ device_id: z.string() }),
});

/**
 * Someone took the computer: a phone started watching or controlling its
 * screen, or Malves took over (handover). Who and when, for `malves audit`.
 * Stays on the computer, like device events.
 */
export const ControlKind = z.enum(["screen_view", "screen_control", "handover"]);
export type ControlKind = z.infer<typeof ControlKind>;

const ControlStarted = z.object({
  type: z.literal("control.started"),
  data: z.object({ kind: ControlKind, device_id: z.string().optional() }),
});

const ControlEnded = z.object({
  type: z.literal("control.ended"),
  data: z.object({ kind: ControlKind, reason: z.string().max(200).optional() }),
});

const ErrorReport = z.object({
  type: z.literal("error"),
  data: z.object({
    code: z.string(),
    message: z.string(),
    task_id: z.string().optional(),
  }),
});

// ── Pillar A: Several agents on one job ──────────────────────────────────────

export const JobId = z.string().min(1);
export type JobId = z.infer<typeof JobId>;

export const StepRole = z.enum(["implementer", "tester", "reviewer", "verifier", "integrator"]);
export type StepRole = z.infer<typeof StepRole>;

export const StepState = z.enum(["pending", "running", "done", "failed"]);
export type StepState = z.infer<typeof StepState>;

export const JobStep = z.object({
  id: z.string().min(1),
  role: StepRole,
  agent: z.string().min(1),
  prompt: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  task_id: z.string().optional(),
  state: StepState.default("pending"),
  summary: z.string().optional(),
});
export type JobStep = z.infer<typeof JobStep>;
export type JobStepInput = z.input<typeof JobStep>;

export const JobState = z.enum([
  "planning",
  "awaiting_plan",
  "running",
  "verifying",
  "awaiting_pr",
  "done",
  "failed",
  "stopped",
]);
export type JobState = z.infer<typeof JobState>;

const JobCreated = z.object({
  type: z.literal("job.created"),
  data: z.object({
    job_id: JobId,
    goal: z.string().min(1),
    workspace_id: z.string(),
  }),
});

const JobPlanned = z.object({
  type: z.literal("job.planned"),
  data: z.object({
    job_id: JobId,
    plan: z.array(JobStep).min(1).max(6),
  }),
});

const JobApproved = z.object({
  type: z.literal("job.approved"),
  data: z.object({
    job_id: JobId,
  }),
});

const JobStepUpdated = z.object({
  type: z.literal("job.step.updated"),
  data: z.object({
    job_id: JobId,
    step_id: z.string(),
    state: StepState,
    task_id: z.string().optional(),
    branch: z.string().optional(),
    worktree: z.string().optional(),
    summary: z.string().optional(),
  }),
});

const JobVerified = z.object({
  type: z.literal("job.verified"),
  data: z.object({
    job_id: JobId,
    passed: z.boolean(),
    output: z.string().max(4000),
    return_count: z.number().int().min(0),
  }),
});

const JobFinished = z.object({
  type: z.literal("job.finished"),
  data: z.object({
    job_id: JobId,
    state: z.enum(["done", "failed", "stopped"]),
    pr_url: z.string().optional(),
    reason: z.string().optional(),
  }),
});

/** An event before the store has given it a sequence number. */
export const EventBody = z.discriminatedUnion("type", [
  WorkspaceRegistered,
  WorkspaceRemoved,
  TaskCreated,
  TaskUpdated,
  TaskResult,
  TaskSession,
  TaskModel,
  TaskUsage,
  TaskChanges,
  TaskCommitted,
  QuestionOpened,
  QuestionClosed,
  DevicePaired,
  DeviceRevoked,
  ControlStarted,
  ControlEnded,
  PolicyDecided,
  PolicyAutonomy,
  AutomationCreated,
  AutomationChanged,
  AutomationRemoved,
  AutomationFired,
  SuggestionOffered,
  SuggestionAccepted,
  SuggestionDismissed,
  JobCreated,
  JobPlanned,
  JobApproved,
  JobStepUpdated,
  JobVerified,
  JobFinished,
  ErrorReport,
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody["type"];

/** An event as stored in the log and sent to the phone. */
export type LoggedEvent = EventBody & {
  /** Position in the log. Strictly increasing, starts at 1. */
  seq: number;
  /** Unix time in milliseconds. */
  at: number;
};

/** Validates a logged event arriving over the link. */
export const LoggedEvent = z.intersection(
  EventBody,
  z.object({ seq: z.number().int().positive(), at: z.number().int() }),
);

export type EventOf<T extends EventType> = Extract<LoggedEvent, { type: T }>;
export type DataOf<T extends EventType> = Extract<EventBody, { type: T }>["data"];
