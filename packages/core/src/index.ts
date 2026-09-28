import { Budget, type BudgetPolicy } from "./budget/budget.js";
import type { Command } from "./command.js";
import { Devices } from "./devices/devices.js";
import { EventLog } from "./events/log.js";
import type { AgentHost, Clock, Ids, Notifier, Random, Store } from "./ports.js";
import { Questions } from "./questions/questions.js";
import { Tasks } from "./tasks/tasks.js";
import { Workspaces } from "./workspaces/workspaces.js";

export {
  Budget,
  type BudgetPolicy,
  type ModelCheck,
  normalise as normaliseModel,
  sameModel,
  type Usage,
} from "./budget/budget.js";
export { type Command, command } from "./command.js";
export { type Device, Devices, PAIRING_TTL_MS, PairingError } from "./devices/devices.js";
export { EventLog, type Listener } from "./events/log.js";
export type * from "./ports.js";
export {
  type Answer,
  type AnswerResult,
  type Ask,
  type OpenQuestion,
  Questions,
} from "./questions/questions.js";
export {
  type NewTask,
  RUNNER_RESTARTED,
  STOPPED_BY_USER,
  STOPPED_WAITING,
  type Task,
  Tasks,
} from "./tasks/tasks.js";
export {
  confine,
  OutsideWorkspaceError,
  type Workspace,
  Workspaces,
} from "./workspaces/workspaces.js";

export type CoreOptions = {
  store: Store;
  clock: Clock;
  ids: Ids;
  random: Random;
  notifier: Notifier;
  host: AgentHost;
  agents: ReadonlyMap<string, Command>;
  questionTimeoutMs: number;
  budget?: BudgetPolicy;
};

export type Core = {
  log: EventLog;
  workspaces: Workspaces;
  questions: Questions;
  tasks: Tasks;
  devices: Devices;
  budget: Budget;
};

/** Builds the core, replays the log, and cleans up anything a restart left behind. */
export function createCore(o: CoreOptions): Core {
  const log = new EventLog(o.store, o.clock);
  const workspaces = new Workspaces(log, o.ids);
  const questions = new Questions(log, o.clock, o.ids, o.notifier);
  const devices = new Devices(log, o.clock, o.ids, o.random);
  const budget = new Budget(log, o.budget ?? { floor: [] });
  const tasks = new Tasks({
    log,
    ids: o.ids,
    questions,
    workspaces,
    host: o.host,
    agents: o.agents,
    questionTimeoutMs: o.questionTimeoutMs,
  });
  log.load();
  questions.recover();
  tasks.recover();
  return { log, workspaces, questions, tasks, devices, budget };
}
