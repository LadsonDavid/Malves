import type {
  AgentInfo,
  Choice,
  LoggedEvent,
  QuestionKind,
  Risk,
  TaskState,
  Welcome,
} from "@malves/protocol";

/**
 * What the phone knows, rebuilt from the runner's event stream. `reduce` is a
 * pure function — the same events always give the same state — so a reconnect
 * that resumes from the last event can't leave the screen inconsistent.
 */

export type Question = {
  id: string;
  taskId: string;
  kind: QuestionKind;
  text: string;
  choices: Choice[];
  risk: Risk;
  expiresAt: number;
};

export type Task = {
  id: string;
  workspaceId: string;
  agent: string;
  prompt: string;
  state: TaskState;
  reason?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
};

export type Model = {
  computer: string | null;
  workspaces: Array<{ id: string; name: string }>;
  /** Each agent and whether it can take a task right now. */
  agents: AgentInfo[];
  tasks: Record<string, Task>;
  /** Open questions only. */
  questions: Record<string, Question>;
};

export type Action =
  | { type: "welcome"; welcome: Welcome }
  | { type: "event"; event: LoggedEvent }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "reset" };

export const emptyModel: Model = {
  computer: null,
  workspaces: [],
  agents: [],
  tasks: {},
  questions: {},
};

export function reduce(model: Model, action: Action): Model {
  switch (action.type) {
    case "agents":
      return { ...model, agents: action.agents };
    case "reset":
      return emptyModel;
    case "welcome":
      return {
        ...model,
        computer: action.welcome.computer,
        workspaces: action.welcome.workspaces,
        agents: action.welcome.agents,
      };
    case "event":
      return apply(model, action.event);
  }
}

function apply(model: Model, event: LoggedEvent): Model {
  switch (event.type) {
    case "workspace.registered": {
      const { workspace_id: id, name } = event.data;
      return {
        ...model,
        workspaces: [...model.workspaces.filter((w) => w.id !== id), { id, name }],
      };
    }
    case "workspace.removed":
      return {
        ...model,
        workspaces: model.workspaces.filter((w) => w.id !== event.data.workspace_id),
      };
    case "task.created": {
      const { task_id: id, workspace_id: workspaceId, agent, prompt } = event.data;
      const task: Task = {
        id,
        workspaceId,
        agent,
        prompt,
        state: "queued",
        createdAt: event.at,
        updatedAt: event.at,
      };
      return { ...model, tasks: { ...model.tasks, [id]: task } };
    }
    case "task.updated":
      return updateTask(model, event.data.task_id, (task) => {
        const { reason: _old, ...rest } = task;
        return {
          ...rest,
          state: event.data.state,
          updatedAt: event.at,
          ...(event.data.reason === undefined ? {} : { reason: event.data.reason }),
        };
      });
    case "task.result":
      return updateTask(model, event.data.task_id, (task) => ({
        ...task,
        result: event.data.text,
      }));
    case "question.opened": {
      const q = event.data;
      const question: Question = {
        id: q.question_id,
        taskId: q.task_id,
        kind: q.kind,
        text: q.text,
        choices: q.choices,
        risk: q.risk,
        expiresAt: q.expires_at,
      };
      return { ...model, questions: { ...model.questions, [question.id]: question } };
    }
    case "question.closed": {
      const { [event.data.question_id]: _closed, ...open } = model.questions;
      return { ...model, questions: open };
    }
    default:
      return model;
  }
}

function updateTask(model: Model, id: string, change: (task: Task) => Task): Model {
  const task = model.tasks[id];
  return task ? { ...model, tasks: { ...model.tasks, [id]: change(task) } } : model;
}

const FINISHED: readonly TaskState[] = ["done", "failed", "stopped"];

/** What needs the user now — oldest first, since it expires first. */
export function needsYou(model: Model): Question[] {
  return Object.values(model.questions).sort((a, b) => a.expiresAt - b.expiresAt);
}

export function running(model: Model): Task[] {
  return Object.values(model.tasks)
    .filter((t) => !FINISHED.includes(t.state))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function recent(model: Model, limit = 10): Task[] {
  return Object.values(model.tasks)
    .filter((t) => FINISHED.includes(t.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/**
 * The agent to suggest for a new task: the one used last if it's ready, else
 * Claude if it's ready, else any ready agent. Never one that would fail.
 */
export function pickAgent(agents: AgentInfo[], lastUsed?: string): string | undefined {
  const ready = agents.filter((a) => a.state === "ready");
  return (
    ready.find((a) => a.name === lastUsed) ??
    ready.find((a) => a.name === "claude") ??
    ready[0]
  )?.name;
}

export function workspaceName(model: Model, id: string): string {
  return model.workspaces.find((w) => w.id === id)?.name ?? id;
}
