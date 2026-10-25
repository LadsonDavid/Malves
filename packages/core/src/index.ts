import { Automations } from "./automations/automations.js";
import { Suggestions } from "./automations/suggestions.js";
import type { Command } from "./command.js";
import { Devices } from "./devices/devices.js";
import { EventLog } from "./events/log.js";
import { type Job, Jobs } from "./jobs/jobs.js";
import type { Advisor } from "./policy/advisor.js";
import { Policy } from "./policy/policy.js";
import type {
  AgentHost,
  Clock,
  Delivery,
  Ids,
  JobVerifier,
  MonitorRunner,
  MonitorState,
  Notifier,
  PullRequestOpener,
  Store,
  WorkspaceProvisioner,
} from "./ports.js";
import { Questions } from "./questions/questions.js";
import { Tasks } from "./tasks/tasks.js";
import { Workspaces } from "./workspaces/workspaces.js";

export { Automations, MAX_DIFF_CHARS, type Rule } from "./automations/automations.js";
export { nextDue, parseSchedule, type Schedule } from "./automations/schedule.js";
export { MAX_PENDING, type Suggestion, Suggestions } from "./automations/suggestions.js";
export { fingerprint, lineDiff } from "./automations/text.js";
export { type Command, command } from "./command.js";
export { type Device, Devices } from "./devices/devices.js";
export { EventLog, type Listener } from "./events/log.js";
export { type Job, Jobs, type JobsOptions } from "./jobs/jobs.js";
export {
  checkAcyclic,
  MAX_PLAN_STEPS,
  parsePlan,
  plannerPrompt,
  validatePlan,
} from "./jobs/planner.js";
export {
  ADVISOR_SYSTEM,
  type Advisor,
  advisorPrompt,
  parseAdvice,
  stripShellComments,
} from "./policy/advisor.js";
export { classifyCommand, insideRoot, isSecretPath } from "./policy/command.js";
export { DEFAULT_DENY, Policy, type PolicyOptions } from "./policy/policy.js";
export type { Action, Classification, PolicyContext, Verdict } from "./policy/types.js";
export type {
  AgentCallbacks,
  AgentEnd,
  AgentHost,
  AgentRun,
  AgentSession,
  Alert,
  Clock,
  Decision,
  Delivery,
  Ids,
  JobVerifier,
  MonitorRunner,
  MonitorSnapshot,
  MonitorState,
  Notifier,
  PullRequestOpener,
  Store,
  WorkspaceProvisioner,
} from "./ports.js";
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
  /**
   * Turns the policy engine on (plan F1): every decision that carries an
   * `action` is judged before anyone is asked. Left out, behaviour is as before.
   */
  policy?: {
    denyGlobs?: () => readonly string[];
    allowedHosts?: () => readonly string[];
    allowedApps?: () => readonly string[];
    advisor?: Advisor | undefined;
    /** How long an answered yes stays valid in a `trusting` project. Default 10 minutes. */
    rememberMs?: number;
  };
  /** Turns automations on (plan F2). They start ticking only when `automations.start()` is called. */
  automations?: {
    monitors: MonitorRunner;
    state: MonitorState;
    delivery: Delivery;
    minGapMs?: number;
  };
  /** Turns multi-agent jobs on (plan Pillar A). */
  jobs?: {
    provisioner: WorkspaceProvisioner;
    verifier: JobVerifier;
    prOpener: PullRequestOpener;
    maxConcurrentSteps?: number | undefined;
  };
};

export type Core = {
  log: EventLog;
  devices: Devices;
  workspaces: Workspaces;
  questions: Questions;
  tasks: Tasks;
  /** Present when `CoreOptions.policy` was given. */
  policy?: Policy;
  /** Present when `CoreOptions.automations` was given. */
  automations?: Automations;
  suggestions?: Suggestions;
  /** Present when `CoreOptions.jobs` was given. */
  jobs?: Jobs;
};

/** Builds the core, replays the log, and cleans up anything a restart left behind. */
export function createCore(o: CoreOptions): Core {
  const log = new EventLog(o.store, o.clock);
  const devices = new Devices(log, o.ids);
  const workspaces = new Workspaces(log, o.ids);
  const questions = new Questions(log, o.clock, o.ids, o.notifier);
  const policy = o.policy
    ? new Policy({
        log,
        clock: o.clock,
        ...(o.policy.denyGlobs ? { denyGlobs: o.policy.denyGlobs } : {}),
        ...(o.policy.allowedHosts ? { allowedHosts: o.policy.allowedHosts } : {}),
        ...(o.policy.allowedApps ? { allowedApps: o.policy.allowedApps } : {}),
        advisor: o.policy.advisor,
        ...(o.policy.rememberMs === undefined ? {} : { rememberMs: o.policy.rememberMs }),
      })
    : undefined;
  const tasks = new Tasks({
    log,
    ids: o.ids,
    questions,
    workspaces,
    host: o.host,
    agents: o.agents,
    questionTimeoutMs: o.questionTimeoutMs,
    policy,
  });
  const automations = o.automations
    ? new Automations({
        log,
        clock: o.clock,
        ids: o.ids,
        tasks,
        monitors: o.automations.monitors,
        state: o.automations.state,
        delivery: o.automations.delivery,
        ...(o.automations.minGapMs === undefined ? {} : { minGapMs: o.automations.minGapMs }),
      })
    : undefined;
  const suggestions = automations ? new Suggestions(log, o.ids, automations) : undefined;
  const jobs = o.jobs
    ? new Jobs({
        log,
        clock: o.clock,
        ids: o.ids,
        tasks,
        workspaces,
        questions,
        provisioner: o.jobs.provisioner,
        verifier: o.jobs.verifier,
        prOpener: o.jobs.prOpener,
        availableAgents: [...o.agents.keys()],
        ...(o.jobs.maxConcurrentSteps === undefined
          ? {}
          : { maxConcurrentSteps: o.jobs.maxConcurrentSteps }),
      })
    : undefined;
  log.load();
  questions.recover();
  tasks.recover();
  jobs?.recover();
  return {
    log,
    devices,
    workspaces,
    questions,
    tasks,
    ...(policy ? { policy } : {}),
    ...(automations ? { automations } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(jobs ? { jobs } : {}),
  };
}
