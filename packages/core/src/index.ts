import type { Command } from "./command.js";
import { Devices } from "./devices/devices.js";
import { EventLog } from "./events/log.js";
import type { AgentHost, Clock, Ids, Notifier, Store } from "./ports.js";
import { Questions } from "./questions/questions.js";
import { Tasks } from "./tasks/tasks.js";
import { Workspaces } from "./workspaces/workspaces.js";

export { type Command, command } from "./command.js";
export { type Device, Devices } from "./devices/devices.js";
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
  MAX_RESULT_CHARS,
  RUNNER_RESTARTED,
  STOPPED_BY_USER,
  STOPPED_WAITING,
  type Task,
  Tasks,
} from "./tasks/tasks.js";
export {
  confine,
  OutsideWorkspaceError,
  samePath,
  type Workspace,
  Workspaces,
} from "./workspaces/workspaces.js";

export type CoreOptions = {
  store: Store;
  clock: Clock;
  ids: Ids;
  notifier: Notifier;
  host: AgentHost;
  agents: ReadonlyMap<string, Command>;
  questionTimeoutMs: number;
};

export type Core = {
  log: EventLog;
  devices: Devices;
  workspaces: Workspaces;
  questions: Questions;
  tasks: Tasks;
};

/** Builds the core, replays the log, and cleans up anything a restart left behind. */
export function createCore(o: CoreOptions): Core {
  const log = new EventLog(o.store, o.clock);
  const devices = new Devices(log, o.ids);
  const workspaces = new Workspaces(log, o.ids);
  const questions = new Questions(log, o.clock, o.ids, o.notifier);
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
  return { log, devices, workspaces, questions, tasks };
}
