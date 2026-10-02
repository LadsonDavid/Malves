import { z } from "zod";
import { isKey } from "./crypto.js";
import { LoggedEvent } from "./events.js";

/**
 * The phone ↔ runner link (§4). Our own small protocol: ACP covers runner ↔
 * agent, but its remote transport is still work in progress, and the phone
 * needs things ACP doesn't model.
 *
 * On the wire: JSON frames over a WebSocket.
 *  1. runner → phone, in the clear: `{type: "challenge", challenge}`
 *  2. phone → runner: `{device, n, c}` — its public key, and a sealed `hello`
 *     that repeats the challenge (so an old hello can't be replayed)
 *  3. from then on, both ways: `{n, c}`, sealed messages only
 * Everything inside `c` is validated with the schemas below on arrival.
 */

export const LINK_VERSION = 1;
export const DEFAULT_PORT = 7717;

/** WebSocket close codes. The phone stops reconnecting on any of these. */
export const CLOSE = {
  NOT_PAIRED: 4001,
  BAD_CODE: 4002,
  VERSION: 4003,
  BAD_MESSAGE: 4004,
  REVOKED: 4005,
} as const;
export const FINAL_CLOSE_CODES: readonly number[] = Object.values(CLOSE);

const Key = z.string().refine(isKey, "not a 32-byte base64 key");
const Token = z.string().min(16).max(128);
const Id = z.string().min(1).max(64);

/** What the QR code on the desktop carries. */
export const PairingOffer = z.object({
  v: z.literal(LINK_VERSION),
  url: z.string().regex(/^wss?:\/\/\S+$/, "must be a ws:// or wss:// URL"),
  runner: Key,
  code: Token,
  computer: z.string().min(1).max(100),
});
export type PairingOffer = z.infer<typeof PairingOffer>;

// ── Frames, in the clear ────────────────────────────────────────────────────

export const ChallengeFrame = z.object({ type: z.literal("challenge"), challenge: Token });
export const FirstFrame = z.object({ device: Key, n: z.string(), c: z.string() });
export const SealedFrame = z.object({ n: z.string(), c: z.string() });

// ── Phone → runner, sealed ──────────────────────────────────────────────────

export const Hello = z.object({
  type: z.literal("hello"),
  v: z.number().int(),
  challenge: Token,
  /** Resume: send me every event after this one. 0 for everything. */
  since_seq: z.number().int().min(0),
  /** Wish List: only these event types. Omitted means all. */
  wish: z.array(z.string().max(40)).max(20).optional(),
  /** Only on the first connection: the code from the QR, and this phone's name. */
  pair: z.object({ code: Token, name: z.string().min(1).max(100) }).optional(),
});
export type Hello = z.infer<typeof Hello>;

export const TaskCreate = z.object({
  type: z.literal("task.create"),
  command_id: Id,
  workspace_id: Id,
  agent: Id,
  prompt: z.string().min(1).max(20_000),
});

export const AnswerCommand = z.object({
  type: z.literal("answer"),
  command_id: Id,
  question_id: Id,
  choice_id: z.string().min(1).max(200),
});

export const TaskStop = z.object({
  type: z.literal("task.stop"),
  command_id: Id,
  task_id: Id,
});

/** Re-check which agents are ready, e.g. right after signing in on the computer. */
export const AgentsCheck = z.object({ type: z.literal("agents.check"), command_id: Id });

/** Things the phone asks the runner to do. Each is acknowledged once, by `command_id`. */
export const Command = z.discriminatedUnion("type", [
  TaskCreate,
  AnswerCommand,
  TaskStop,
  AgentsCheck,
]);
export type Command = z.infer<typeof Command>;

// ── Runner → phone, sealed ──────────────────────────────────────────────────

/** Whether an agent can take a task right now, as last checked on the computer. */
export const AgentState = z.enum(["checking", "ready", "needs_sign_in", "unavailable"]);
export type AgentState = z.infer<typeof AgentState>;

export const AgentInfo = z.object({
  name: z.string(),
  /** e.g. "Claude" */
  label: z.string(),
  state: AgentState,
  /** What the user can do about it, in plain words. */
  hint: z.string().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const Welcome = z.object({
  type: z.literal("welcome"),
  v: z.number().int(),
  device_id: Id,
  computer: z.string(),
  workspaces: z.array(z.object({ id: Id, name: z.string() })),
  agents: z.array(AgentInfo),
  last_seq: z.number().int().min(0),
});
export type Welcome = z.infer<typeof Welcome>;

/** Sent whenever an agent's readiness changes. */
export const AgentsMessage = z.object({ type: z.literal("agents"), agents: z.array(AgentInfo) });

export const EventMessage = z.object({ type: z.literal("event"), event: LoggedEvent });

export const Ack = z.object({
  type: z.literal("ack"),
  command_id: Id,
  ok: z.boolean(),
  /** e.g. the new task's id, or how an answer was applied. */
  result: z.string().optional(),
  error: z.string().optional(),
});
export type Ack = z.infer<typeof Ack>;

export const RunnerMessage = z.discriminatedUnion("type", [
  Welcome,
  AgentsMessage,
  EventMessage,
  Ack,
]);
export type RunnerMessage = z.infer<typeof RunnerMessage>;
