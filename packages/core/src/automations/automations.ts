import { AutomationRule } from "@malves/protocol";
import type { EventLog } from "../events/log.js";
import type { Clock, Delivery, Ids, MonitorRunner, MonitorState } from "../ports.js";
import type { Task, Tasks } from "../tasks/tasks.js";
import { nextDue, parseSchedule } from "./schedule.js";
import { clip, fingerprint, lineDiff, render } from "./text.js";

export type Rule = AutomationRule & { id: string };

export type AutomationsOptions = {
  log: EventLog;
  clock: Clock;
  ids: Ids;
  tasks: Pick<Tasks, "create" | "whenFinished" | "get">;
  monitors: MonitorRunner;
  state: MonitorState;
  delivery: Delivery;
  /** A rule that reacts to events fires at most this often. Stops a failing task from feeding itself. */
  minGapMs?: number;
};

/** The diff a monitor hands to a task or a template is cut to this. */
export const MAX_DIFF_CHARS = 4_000;
/** The scheduler looks again at least this often, so a rule change or a long sleep is never missed. */
const MAX_WAIT_MS = 60_000;

type Reason = "schedule" | "event" | "monitor";
type Vars = Record<string, string>;

/**
 * Rules that run without being asked: schedules, monitors, and reactions to
 * events (plan F2).
 *
 * - Rules live in the event log; nothing else is the truth.
 * - A monitor reads a cheap source and fingerprints its exact output. Unchanged:
 *   no event, no message, no model. Changed (or the first reading): the diff goes
 *   into a template or a short task, and the answer is delivered by importance.
 * - Every firing is an `automation.fired` event, shown in the journal and by
 *   `malves audit`.
 */
export class Automations {
  private readonly rules = new Map<string, Rule>();
  private readonly nextAt = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly lastEventFire = new Map<string, number>();
  /** Tasks an automation started: their own end never triggers another automation. */
  private readonly ownTasks = new Set<string>();
  private cancelTimer: (() => void) | undefined;
  private started = false;

  constructor(private readonly o: AutomationsOptions) {
    o.log.subscribe((event) => {
      switch (event.type) {
        case "automation.created":
        case "automation.changed":
          this.rules.set(event.data.rule_id, { ...event.data.rule, id: event.data.rule_id });
          if (this.started) this.schedule(event.data.rule_id);
          break;
        case "automation.removed":
          this.rules.delete(event.data.rule_id);
          this.nextAt.delete(event.data.rule_id);
          break;
        case "task.updated":
          if (this.started && (event.data.state === "failed" || event.data.state === "done")) {
            this.onTaskEnded(event.data.task_id, event.data.state);
          }
          break;
      }
    });
  }

  create(input: AutomationRule): Rule {
    const rule = this.validate(input);
    const id = this.o.ids.next("a");
    this.o.log.append({ type: "automation.created", data: { rule_id: id, rule } });
    this.arm();
    return { ...rule, id };
  }

  change(id: string, patch: Partial<AutomationRule>): Rule {
    const current = this.rules.get(id);
    if (!current) throw new Error(`Unknown automation: ${id}`);
    const { id: _id, ...rest } = current;
    const rule = this.validate({ ...rest, ...patch });
    this.o.log.append({ type: "automation.changed", data: { rule_id: id, rule } });
    this.arm();
    return { ...rule, id };
  }

  remove(id: string): boolean {
    if (!this.rules.has(id)) return false;
    this.o.log.append({ type: "automation.removed", data: { rule_id: id } });
    this.o.state.remove(id);
    this.arm();
    return true;
  }

  get(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  list(): Rule[] {
    return [...this.rules.values()];
  }

  /** Begins watching the clock and the log. Call after the log has been replayed. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const id of this.rules.keys()) this.schedule(id);
    this.arm();
  }

  stop(): void {
    this.started = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** Runs every timed rule that is due now. The timer calls this; tests call it directly. */
  async runDue(): Promise<void> {
    const now = this.o.clock.now();
    const due = [...this.rules.values()].filter(
      (r) => r.enabled && this.timed(r) && (this.nextAt.get(r.id) ?? Infinity) <= now,
    );
    await Promise.allSettled(
      due.map(async (rule) => {
        if (this.running.has(rule.id)) return;
        this.running.add(rule.id);
        // Next time is set before running, so a slow or failing rule can't spin.
        this.schedule(rule.id);
        try {
          if (rule.trigger.kind === "monitor") await this.check(rule);
          else await this.fire(rule, "schedule", { name: rule.name });
        } catch (error) {
          this.failed(rule, error);
        } finally {
          this.running.delete(rule.id);
        }
      }),
    );
    this.arm();
  }

  private validate(input: AutomationRule): AutomationRule {
    const rule = AutomationRule.parse(input);
    const { trigger } = rule;
    if (trigger.kind === "schedule") parseSchedule(trigger.schedule);
    if (trigger.kind === "monitor") parseSchedule(trigger.every);
    return rule;
  }

  private timed(rule: Rule): boolean {
    return rule.trigger.kind === "schedule" || rule.trigger.kind === "monitor";
  }

  /** Works out when a timed rule is next due. A monitor looks right away: unchanged is silent. */
  private schedule(id: string): void {
    const rule = this.rules.get(id);
    if (!rule || !this.timed(rule)) return;
    const now = this.o.clock.now();
    const text =
      rule.trigger.kind === "schedule"
        ? rule.trigger.schedule
        : rule.trigger.kind === "monitor"
          ? rule.trigger.every
          : "";
    const when = parseSchedule(text);
    const first = !this.nextAt.has(id) && rule.trigger.kind === "monitor";
    this.nextAt.set(id, first ? now : nextDue(when, now));
  }

  private arm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.started) return;
    let soonest = Infinity;
    for (const rule of this.rules.values()) {
      if (!rule.enabled || !this.timed(rule)) continue;
      if (!this.nextAt.has(rule.id)) this.schedule(rule.id);
      soonest = Math.min(soonest, this.nextAt.get(rule.id) ?? Infinity);
    }
    if (soonest === Infinity) return;
    const wait = Math.min(Math.max(0, soonest - this.o.clock.now()), MAX_WAIT_MS);
    this.cancelTimer = this.o.clock.schedule(wait, () => void this.runDue());
  }

  private async check(rule: Rule): Promise<void> {
    if (rule.trigger.kind !== "monitor") return;
    let output: string;
    try {
      output = await this.o.monitors.read(rule.trigger.source);
    } catch (error) {
      // An unreadable source is itself something to hear about once, not every check.
      output = `(couldn't read the source: ${error instanceof Error ? error.message : String(error)})`;
    }
    const hash = fingerprint(output);
    const before = this.o.state.get(rule.id);
    // Unchanged: no model call, no message, not even an event.
    if (before?.hash === hash) return;
    const diff = before
      ? lineDiff(before.text, output, MAX_DIFF_CHARS)
      : clip(output, MAX_DIFF_CHARS);
    this.o.state.set(rule.id, { hash, text: clip(output, 8_000) });
    const vars = { name: rule.name, diff, output: clip(output, MAX_DIFF_CHARS) };
    await this.fire(rule, "monitor", vars);
    this.react("monitor.changed", { name: rule.name, diff, reason: "" });
  }

  private onTaskEnded(taskId: string, state: "failed" | "done"): void {
    if (this.ownTasks.has(taskId)) return;
    const task: Task | undefined = this.o.tasks.get(taskId);
    this.react(state === "failed" ? "task.failed" : "task.done", {
      name: "",
      diff: "",
      task: clip(task?.prompt ?? taskId, 120),
      reason: task?.reason ?? "",
    });
  }

  /** Rules that listen for this event. Each fires at most once per `minGapMs`. */
  private react(on: "task.failed" | "task.done" | "monitor.changed", vars: Vars): void {
    const gap = this.o.minGapMs ?? 60_000;
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.trigger.kind !== "event" || rule.trigger.on !== on) continue;
      const now = this.o.clock.now();
      const last = this.lastEventFire.get(rule.id);
      if (last !== undefined && now - last < gap) continue;
      this.lastEventFire.set(rule.id, now);
      void this.fire(rule, "event", { ...vars, name: rule.name, source: vars.name ?? "" }).catch(
        (error: unknown) => this.failed(rule, error),
      );
    }
  }

  private async fire(rule: Rule, reason: Reason, vars: Vars): Promise<void> {
    let text: string;
    let taskId: string | undefined;
    if (rule.action.kind === "notify") {
      text = render(rule.action.template, vars);
    } else {
      taskId = this.o.tasks.create({
        workspaceId: rule.action.workspace_id,
        agent: rule.action.agent,
        prompt: render(rule.action.prompt, vars),
      });
      this.ownTasks.add(taskId);
      const task = await this.o.tasks.whenFinished(taskId);
      text =
        task.result?.trim() || `The task ${task.state}${task.reason ? `: ${task.reason}` : "."}`;
    }
    text = clip(text, 4_000);
    this.o.log.append({
      type: "automation.fired",
      data: {
        rule_id: rule.id,
        reason,
        importance: rule.importance,
        text,
        ...(taskId ? { task_id: taskId } : {}),
      },
    });
    if (rule.importance === "log") return;
    await this.o.delivery
      .deliver({ ruleId: rule.id, name: rule.name, text, importance: rule.importance })
      .catch((error: unknown) => this.failed(rule, error, "delivery_failed"));
  }

  private failed(rule: Rule, error: unknown, code = "automation_failed"): void {
    this.o.log.append({
      type: "error",
      data: {
        code,
        message: clip(
          `${rule.name}: ${error instanceof Error ? error.message : String(error)}`,
          300,
        ),
      },
    });
  }
}
