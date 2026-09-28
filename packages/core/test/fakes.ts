import {
  type AgentCallbacks,
  type AgentEnd,
  type AgentHost,
  type AgentRun,
  type AgentSession,
  type Clock,
  type CoreOptions,
  command,
  createCore,
  type Ids,
  type Notifier,
  type OpenQuestion,
  type Store,
} from "@malves/core";
import type { EventBody, LoggedEvent } from "@malves/protocol";

export class MemoryStore implements Store {
  readonly events: LoggedEvent[] = [];
  append(body: EventBody, at: number): LoggedEvent {
    const event = { ...body, seq: this.events.length + 1, at } as LoggedEvent;
    this.events.push(event);
    return event;
  }
  since(after: number, limit: number): LoggedEvent[] {
    return this.events.filter((e) => e.seq > after).slice(0, limit);
  }
}

/** Time only moves when a test says so. */
export class FakeClock implements Clock {
  private t = 1_000_000;
  private timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  now(): number {
    return this.t;
  }
  schedule(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((x) => x.live && x.at <= this.t);
    this.timers = this.timers.filter((x) => !due.includes(x));
    for (const timer of due) timer.fn();
  }
}

export class CounterIds implements Ids {
  private n = 0;
  next(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.n}`;
  }
}

export class RecordingNotifier implements Notifier {
  readonly sent: OpenQuestion[] = [];
  fail = false;
  async questionOpened(question: OpenQuestion): Promise<void> {
    if (this.fail) throw new Error("push service down");
    this.sent.push(question);
  }
}

export type AgentScript = (agent: {
  callbacks: AgentCallbacks;
  /** Records an action; throws if the agent was cancelled first. */
  act(name: string): void;
}) => Promise<AgentEnd>;

/** An agent host that runs a scripted "agent" in-process and records what it did. */
export class ScriptedHost implements AgentHost {
  readonly actions: string[] = [];
  readonly runs: AgentRun[] = [];
  readonly cancelled: string[] = [];
  script: AgentScript = async () => "completed";

  start(run: AgentRun, callbacks: AgentCallbacks): AgentSession {
    this.runs.push(run);
    let dead = false;
    const finished = this.script({
      callbacks,
      act: (name) => {
        if (dead) throw new Error(`action after cancel: ${name}`);
        this.actions.push(name);
      },
    });
    return {
      finished,
      cancel: async () => {
        dead = true;
        this.cancelled.push(run.taskId);
      },
    };
  }
}

export const TIMEOUT = 60_000;

export function setup(overrides: Partial<CoreOptions> = {}) {
  const store = new MemoryStore();
  const clock = new FakeClock();
  const ids = new CounterIds();
  const notifier = new RecordingNotifier();
  const host = new ScriptedHost();
  const options: CoreOptions = {
    store,
    clock,
    ids,
    notifier,
    host,
    agents: new Map([["demo", command("demo-agent")]]),
    questionTimeoutMs: TIMEOUT,
    ...overrides,
  };
  const core = createCore(options);
  return { ...core, store, clock, ids, notifier, host, options };
}

/** Lets pending promise callbacks run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export const types = (store: MemoryStore) => store.events.map((e) => e.type);
