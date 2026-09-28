import { z } from "zod";
import { type EventBody, PushSubscription } from "./events.js";

/**
 * Messages between the phone and the runner (§4). They travel inside the
 * encrypted channel (see channel.ts), so the relay and the push service never
 * see them. Field names use the wire convention (snake_case).
 */

/** Protocol versions this code speaks. The runner serves the current and previous ("Two in Production"). */
export const LINK_VERSIONS = [1] as const;
export const LINK_VERSION = 1;

/** What the phone subscribes to ("Wish List"). */
export const Wish = z.enum(["tasks", "questions", "workspaces", "budget", "errors"]);
export type Wish = z.infer<typeof Wish>;

/** Which wish each event type belongs to. Device events never leave the runner. */
export function wishOf(type: EventBody["type"]): Wish | undefined {
  if (type.startsWith("task.")) return "tasks";
  if (type.startsWith("question.")) return "questions";
  if (type.startsWith("workspace.")) return "workspaces";
  if (type.startsWith("budget.")) return "budget";
  if (type === "error") return "errors";
  return undefined;
}

const id = z.string().min(1).max(100);

// ---- phone → runner ---------------------------------------------------------

const Hello = z.object({
  t: z.literal("hello"),
  v: z.number().int(),
  /** The challenge the runner sent in plaintext, proving this isn't a replay. */
  r: z.string(),
  since_seq: z.number().int().min(0),
  wish: z.array(Wish).min(1),
});

const Pair = z.object({
  t: z.literal("pair"),
  v: z.number().int(),
  r: z.string(),
  secret: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
});

const TaskCreate = z.object({
  t: z.literal("task.create"),
  id,
  workspace_id: id,
  agent: id,
  prompt: z.string().min(1).max(20_000),
  browser: z.boolean().optional(),
});

const AnswerCmd = z.object({
  t: z.literal("answer"),
  id,
  question_id: id,
  choice_id: id,
});

const TaskStop = z.object({ t: z.literal("task.stop"), id, task_id: id });

const ComputerStatus = z.object({ t: z.literal("computer.status"), id });

const PushRegister = z.object({
  t: z.literal("push.register"),
  id,
  subscription: PushSubscription,
});

const History = z.object({
  t: z.literal("history"),
  id,
  /** Return events before this sequence number, newest first ("Pagination"). */
  before_seq: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(200),
});

/** First message on a connection. */
export const Opening = z.discriminatedUnion("t", [Hello, Pair]);
export type Opening = z.infer<typeof Opening>;

/** Every later message from the phone. Each carries a phone-generated id. */
export const Command = z.discriminatedUnion("t", [
  TaskCreate,
  AnswerCmd,
  TaskStop,
  ComputerStatus,
  PushRegister,
  History,
]);
export type Command = z.infer<typeof Command>;

// ---- runner → phone ---------------------------------------------------------

export type WorkspaceInfo = { id: string; name: string };
export type AgentInfo = { name: string; available: boolean };

export type Welcome = {
  t: "welcome";
  v: number;
  runner_id: string;
  name: string;
  last_seq: number;
  workspaces: WorkspaceInfo[];
  agents: AgentInfo[];
  /** VAPID public key for UnifiedPush registration; absent if push is off. */
  vapid_public_key?: string;
};

export type Paired = { t: "paired"; runner_id: string; device_id: string; name: string };

export type EventMsg = { t: "event"; event: import("./events.js").LoggedEvent };

export type Ack = { t: "ack"; id: string; result: string; data?: unknown };

/** "Error Report": errors are messages with a code, never strings in a field. */
export type ErrorMsg = { t: "error"; id?: string; code: ErrorCode; message: string };

export type ErrorCode =
  | "bad_message"
  | "unsupported_version"
  | "not_paired"
  | "pairing_failed"
  | "rejected"
  | "internal";

export type Heartbeat = { t: "heartbeat"; at: number; last_seq: number };

export type Reply = Welcome | Paired | EventMsg | Ack | ErrorMsg | Heartbeat;
