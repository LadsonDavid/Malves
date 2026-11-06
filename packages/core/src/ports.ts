import type {
  Choice,
  DataOf,
  EventBody,
  Importance,
  LoggedEvent,
  MonitorSource,
  QuestionKind,
  Risk,
  ToolProgress,
} from "@malves/protocol";
import type { Command } from "./command.js";
import type { Action } from "./policy/types.js";

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
}

export interface Clock {
  now(): number;
  /** Runs `fn` after `ms`. Returns a function that cancels it. */
  schedule(ms: number, fn: () => void): () => void;
}

export interface Ids {
  next(prefix: string): string;
}

/**
 * Sends a push hint about a new question. A failure is harmless: the event log
 * is the truth (§4).
 */
export interface Notifier {
  questionOpened(question: DataOf<"question.opened">): Promise<void>;
  /**
   * The question is still open: nudge again (`n` is 1, then 2). Optional, and a
   * failure is as harmless as for `questionOpened`. A reminder never changes
   * the outcome: silence still ends the question as timed out (R3).
   */
  questionReminder?(question: DataOf<"question.opened">, n: number): Promise<void>;
}

/** Something an agent needs a person to decide. */
export type Decision = {
  /** Only agent clarifications may accept text through this explicitly named choice. */
  textChoiceId?: string;
  kind: QuestionKind;
  text: string;
  choices: Choice[];
  risk: Risk;
  /**
   * What is being asked for, in structured form. With a policy on, the policy
   * judges this first: tier 1 (and tier 2 when the project's autonomy allows) is
   * allowed without a question, a hard deny is refused, everything else is asked.
   */
  action?: Action;
  /** The choice that means "yes, once", used when the policy allows without asking. */
  allowChoice?: string;
};

export type AgentRun = {
  taskId: string;
  /** The agent's name, e.g. "claude" — for messages the user sees. */
  agent: string;
  command: Command;
  /** The registered workspace root. The agent's cwd, and the limit of its file access. */
  workspaceRoot: string;
  prompt: string;
  /** Continue this earlier agent session instead of starting a new one. */
  resume?: string;
};

export type AgentCallbacks = {
  /**
   * Asks a person. Resolves with the chosen choice id, or `null` when the task
   * has been stopped and the agent must not proceed.
   */
  decide(decision: Decision): Promise<string | null>;
  /** The agent session is open; its id lets a later task continue the conversation. */
  session(id: string): void;
  /** Text the agent wants to show the user. */
  output(text: string): void;
  /** Display-only tool status/results, never an authorization to execute. */
  tool?(progress: ToolProgress): void;
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

// ── Automations (plan F2) ───────────────────────────────────────────────────

/** Reads what a monitor watches. Throws when the source can't be read. */
export interface MonitorRunner {
  read(source: MonitorSource): Promise<string>;
}

/** What a monitor saw last time: its fingerprint, and its text so a diff can be shown. */
export type MonitorSnapshot = { hash: string; text: string };

export interface MonitorState {
  get(ruleId: string): MonitorSnapshot | undefined;
  set(ruleId: string, snapshot: MonitorSnapshot): void;
  remove(ruleId: string): void;
}

export type Alert = { ruleId: string; name: string; text: string; importance: Importance };

/**
 * Tells the person: a notification, or a call for the important ones. The
 * adapter decides how; a failure is logged and never stops an automation.
 */
export interface Delivery {
  deliver(alert: Alert): Promise<void>;
}

// ── Jobs (plan Pillar A) ────────────────────────────────────────────────────

export interface WorkspaceProvisioner {
  /** Creates an isolated worktree and branch for one step in a job. */
  create(
    workspacePath: string,
    jobId: string,
    stepId: string,
  ): Promise<{ root: string; branch: string }>;
  /** Removes one step's worktree. */
  remove(workspacePath: string, jobId: string, stepId: string): Promise<void>;
  /** Merges sourceBranch into targetBranch in the workspace or integration worktree. */
  merge(
    workspacePath: string,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<{ success: boolean; conflictFiles?: string[] }>;
  /** Removes all worktrees and temporary branches created for this job. */
  cleanup(workspacePath: string, jobId: string): Promise<void>;
}

export interface JobVerifier {
  /** Runs tests and lints in the target directory; returns passed boolean and output. */
  verify(root: string): Promise<{ passed: boolean; output: string }>;
}

export interface PullRequestOpener {
  /** Opens a pull request for the integration branch. */
  createPr(
    workspacePath: string,
    branch: string,
    title: string,
    body: string,
  ): Promise<{ url: string }>;
}
