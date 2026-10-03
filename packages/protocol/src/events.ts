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

/** Tokens a metered task used, through the budget guard. Logged when it ends. */
const TaskUsage = z.object({
  type: z.literal("task.usage"),
  data: z.object({
    task_id: z.string(),
    calls: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
  }),
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

const ErrorReport = z.object({
  type: z.literal("error"),
  data: z.object({
    code: z.string(),
    message: z.string(),
    task_id: z.string().optional(),
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
  QuestionOpened,
  QuestionClosed,
  DevicePaired,
  DeviceRevoked,
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
