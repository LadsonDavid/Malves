import type { Choice, DataOf, EventBody, LoggedEvent, QuestionKind, Risk } from "@malves/protocol";
import type { Command } from "./command.js";

/**
 * Interfaces the core owns (§3). Adapters implement them; the core never knows
 * which tool is on the other side.
 */

/** Append-only event storage. Nothing is ever updated or deleted. */
export interface Store {
  /** Appends one event and returns it with its sequence number. */
  append(body: EventBody, at: number): LoggedEvent;
  /** Events with `seq` greater than `after`, oldest first, at most `limit`. */
  since(after: number, limit: number): LoggedEvent[];
  /** Events with `seq` less than `before`, newest first, at most `limit`. */
  before(before: number, limit: number): LoggedEvent[];
}

export interface Clock {
  now(): number;
  /** Runs `fn` after `ms`. Returns a function that cancels it. */
  schedule(ms: number, fn: () => void): () => void;
}

export interface Ids {
  next(prefix: string): string;
}

/** Cryptographically secure randomness. */
export interface Random {
  /** `bytes` random bytes, base64url-encoded. */
  token(bytes: number): string;
}

/**
 * Sends a push hint about a new question. A failure is harmless: the event log
 * is the truth (§4).
 */
export interface Notifier {
  questionOpened(question: DataOf<"question.opened">): Promise<void>;
}

/** Something an agent needs a person to decide. */
export type Decision = {
  kind: QuestionKind;
  text: string;
  choices: Choice[];
  risk: Risk;
};

export type AgentRun = {
  taskId: string;
  /** The agent's name in the runner's catalogue. */
  agent: string;
  command: Command;
  /** The registered workspace root. The agent's cwd, and the limit of its file access. */
  workspaceRoot: string;
  prompt: string;
  /** Give the agent the gated browser tools (§5). */
  browser: boolean;
};

export type AgentCallbacks = {
  /**
   * Asks a person. Resolves with the chosen choice id, or `null` when the task
   * has been stopped and the agent must not proceed.
   */
  decide(decision: Decision): Promise<string | null>;
  /** Text the agent wants to show the user. */
  output(text: string): void;
  /** Resolves a path the agent asked for, or throws if it is outside the workspace. */
  confine(path: string): string;
};

export type AgentEnd = "completed" | "cancelled" | "refused" | "limit_reached";

export interface AgentSession {
  /** Settles when the agent's turn ends. Rejects if the agent fails. */
  readonly finished: Promise<AgentEnd>;
  /** Stops the agent. Once this resolves, the agent can take no further action. */
  cancel(): Promise<void>;
}

export interface AgentHost {
  start(run: AgentRun, callbacks: AgentCallbacks): AgentSession;
}
