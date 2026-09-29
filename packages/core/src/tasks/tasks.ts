import { type TaskState, TERMINAL_STATES } from "@malves/protocol";
import type { Command } from "../command.js";
import type { EventLog } from "../events/log.js";
import type { AgentEnd, AgentHost, AgentSession, Decision, Ids } from "../ports.js";
import type { Answer, Questions } from "../questions/questions.js";
import { confine, type Workspaces } from "../workspaces/workspaces.js";

export type Task = {
  id: string;
  workspaceId: string;
  agent: string;
  prompt: string;
  state: TaskState;
  reason?: string;
  result?: string;
};

/** The result keeps at most this much of the agent's text: the end, where the summary is. */
export const MAX_RESULT_CHARS = 100_000;

export const STOPPED_WAITING = "Stopped waiting. Nothing changed after the question.";
export const STOPPED_BY_USER = "Stopped by you.";
export const RUNNER_RESTARTED = "The runner restarted while this task was active.";

const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "failed", "stopped"],
  running: ["waiting", "done", "failed", "stopped"],
  waiting: ["running", "failed", "stopped"],
  done: [],
  failed: [],
  stopped: [],
};

export type TasksOptions = {
  log: EventLog;
  ids: Ids;
  questions: Questions;
  workspaces: Workspaces;
  host: AgentHost;
  /** Agent name → how to start it. Only these can be run. */
  agents: ReadonlyMap<string, Command>;
  questionTimeoutMs: number;
};

/** queued → running ⇄ waiting → done | failed | stopped (§3). */
export class Tasks {
  private readonly tasks = new Map<string, Task>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly finished = new Map<string, Array<(task: Task) => void>>();
  /** Questions each task is waiting on. An agent may ask several at once. */
  private readonly asking = new Map<string, number>();

  constructor(private readonly o: TasksOptions) {
    o.log.subscribe((event) => {
      switch (event.type) {
        case "task.created": {
          const { task_id: id, workspace_id: workspaceId, agent, prompt } = event.data;
          this.tasks.set(id, { id, workspaceId, agent, prompt, state: "queued" });
          break;
        }
        case "task.updated": {
          const task = this.tasks.get(event.data.task_id);
          if (!task) break;
          task.state = event.data.state;
          if (event.data.reason === undefined) delete task.reason;
          else task.reason = event.data.reason;
          if (isTerminal(task.state)) {
            for (const resolve of this.finished.get(task.id) ?? []) resolve({ ...task });
            this.finished.delete(task.id);
          }
          break;
        }
        case "task.result": {
          const task = this.tasks.get(event.data.task_id);
          if (task) task.result = event.data.text;
          break;
        }
      }
    });
  }

  /** Starts a task in a registered workspace, with a known agent. Returns its id. */
  create(input: { workspaceId: string; agent: string; prompt: string }): string {
    const workspace = this.o.workspaces.get(input.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const agentCommand = this.o.agents.get(input.agent);
    if (!agentCommand) throw new Error(`Unknown agent: ${input.agent}`);
    if (input.prompt.trim() === "") throw new Error("The task needs a description");

    const id = this.o.ids.next("t");
    this.o.log.append({
      type: "task.created",
      data: { task_id: id, workspace_id: workspace.id, agent: input.agent, prompt: input.prompt },
    });
    void this.run(id, agentCommand, workspace.path);
    return id;
  }

  async stop(taskId: string, reason = STOPPED_BY_USER): Promise<void> {
    await this.halt(taskId, "stopped", reason);
  }

  /** Breakglass: stops every active task. */
  async stopAll(reason = STOPPED_BY_USER): Promise<void> {
    await Promise.all(
      this.list()
        .filter((t) => !isTerminal(t.state))
        .map((t) => this.stop(t.id, reason)),
    );
  }

  get(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task && { ...task };
  }

  list(): Task[] {
    return [...this.tasks.values()].map((t) => ({ ...t }));
  }

  /** Resolves once the task reaches done, failed or stopped. */
  whenFinished(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.reject(new Error(`Unknown task: ${taskId}`));
    if (isTerminal(task.state)) return Promise.resolve({ ...task });
    return new Promise((resolve) => {
      const list = this.finished.get(taskId) ?? [];
      list.push(resolve);
      this.finished.set(taskId, list);
    });
  }

  /** Tasks that were active when the runner last stopped can't be resumed: mark them failed. */
  recover(): void {
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.state) && !this.sessions.has(task.id)) {
        this.transition(task.id, "failed", RUNNER_RESTARTED);
      }
    }
  }

  private async run(taskId: string, agentCommand: Command, root: string): Promise<void> {
    let output = "";
    try {
      this.transition(taskId, "running");
      const session = this.o.host.start(
        {
          taskId,
          command: agentCommand,
          workspaceRoot: root,
          prompt: this.tasks.get(taskId)?.prompt ?? "",
        },
        {
          decide: (decision) => this.decide(taskId, decision),
          output: (text) => {
            output += text;
            if (output.length > 2 * MAX_RESULT_CHARS) output = output.slice(-MAX_RESULT_CHARS);
          },
          confine: (path) => this.confine(taskId, root, path),
        },
      );
      this.sessions.set(taskId, session);
      const end = await session.finished;
      if (this.isActive(taskId)) this.finish(taskId, end, output);
    } catch (error) {
      if (this.isActive(taskId)) {
        this.transition(taskId, "failed", error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.sessions.delete(taskId);
    }
  }

  /**
   * An agent may ask several questions at once. The task is `waiting` while any
   * of them is open, and goes back to `running` only when the last one closes.
   */
  private async decide(taskId: string, decision: Decision): Promise<string | null> {
    if (!this.isActive(taskId)) return null;
    const open = (this.asking.get(taskId) ?? 0) + 1;
    this.asking.set(taskId, open);
    if (open === 1) this.transition(taskId, "waiting");

    let answer: Answer;
    let stillOpen: number;
    try {
      answer = await this.o.questions.ask({
        ...decision,
        taskId,
        timeoutMs: this.o.questionTimeoutMs,
      });
    } finally {
      stillOpen = (this.asking.get(taskId) ?? 1) - 1;
      if (stillOpen > 0) this.asking.set(taskId, stillOpen);
      else this.asking.delete(taskId);
    }

    if (answer.outcome === "answered" && this.isActive(taskId)) {
      if (stillOpen === 0) this.transition(taskId, "running");
      return answer.choiceId;
    }
    // Silence never means yes (R3): the agent is stopped before it hears back.
    if (answer.outcome === "timed_out") await this.halt(taskId, "stopped", STOPPED_WAITING);
    return null;
  }

  /** Every refused path is logged: it is either a bug or an attempt to leave the workspace. */
  private confine(taskId: string, root: string, requested: string): string {
    try {
      return confine(root, requested);
    } catch (error) {
      this.o.log.append({
        type: "error",
        data: { code: "outside_workspace", message: `Refused: ${requested}`, task_id: taskId },
      });
      throw error;
    }
  }

  private finish(taskId: string, end: AgentEnd, output: string): void {
    const text =
      output.length > MAX_RESULT_CHARS ? `…${output.slice(-(MAX_RESULT_CHARS - 1))}` : output;
    if (text !== "") this.o.log.append({ type: "task.result", data: { task_id: taskId, text } });
    switch (end) {
      case "completed":
        this.transition(taskId, "done");
        break;
      case "cancelled":
        this.transition(taskId, "stopped", "The agent cancelled the task.");
        break;
      case "refused":
        this.transition(taskId, "failed", "The agent refused the task.");
        break;
      case "limit_reached":
        this.transition(taskId, "failed", "The agent hit its token or turn limit.");
        break;
    }
  }

  /** Records the terminal state first, so nothing else can proceed, then stops the agent. */
  private async halt(taskId: string, state: "stopped" | "failed", reason: string): Promise<void> {
    if (!this.isActive(taskId)) return;
    this.transition(taskId, state, reason);
    this.o.questions.cancelTask(taskId);
    await this.sessions.get(taskId)?.cancel();
  }

  private isActive(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task !== undefined && !isTerminal(task.state);
  }

  private transition(taskId: string, to: TaskState, reason?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (!ALLOWED[task.state].includes(to)) {
      throw new Error(`Task ${taskId} cannot go from ${task.state} to ${to}`);
    }
    this.o.log.append({
      type: "task.updated",
      data: { task_id: taskId, state: to, ...(reason === undefined ? {} : { reason }) },
    });
  }
}

function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}
